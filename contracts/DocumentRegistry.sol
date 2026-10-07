// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AasthiChain Document Registry
 * @notice Tamper-proof anchoring of property and instrument documents.
 * @dev    The EVM mirror of drunix-gateway/documents.go. Same semantics, same
 *         sentinels, so a counterparty who will only trust a public chain gets
 *         the identical guarantee the permissioned rail gives.
 *
 *         WHAT IS STORED: the IPFS CID and the SHA-256 digest of a document,
 *         plus who anchored it and when.
 *
 *         WHAT IS NEVER STORED: the document. Putting a scanned deed on a
 *         public chain is both ruinously expensive and an irreversible privacy
 *         breach — a deed carries names, addresses and signatures, and nothing
 *         on a public chain can ever be withdrawn. The digest is sufficient:
 *         anyone holding the file can recompute it and check, and anyone who
 *         should have the file can fetch it from IPFS by its CID.
 *
 *         WHY A CID AND A DIGEST: the CID makes the document retrievable and
 *         self-verifying on IPFS; the SHA-256 is what the existing Fabric
 *         chaincode and /api/properties/:id/verify-document already speak.
 *         Recording both keeps the two worlds interoperable.
 *
 *         APPEND-ONLY: there is no delete and no overwrite. A document that
 *         turns out to be forged is REVOKED, which adds a fact on top of the
 *         original anchor rather than erasing it. A register that can forget
 *         is not evidence of anything.
 */
contract DocumentRegistry {
    enum Status {
        NONE,       // never anchored
        ACTIVE,     // anchored and current
        SUPERSEDED, // replaced by a newer version
        REVOKED     // withdrawn; do not rely on it
    }

    struct Document {
        bytes32 assetId;      // keccak256 of the AasthiChain asset id
        bytes32 sha256Digest; // SHA-256 of the file, the digest Fabric stores
        string  cid;          // IPFS CIDv1, the retrievable name
        string  docType;      // TITLE_DEED, ENCUMBRANCE_CERTIFICATE, ...
        address anchoredBy;
        uint64  anchoredAt;
        uint64  validFrom;    // 0 = unbounded
        uint64  validTo;      // 0 = unbounded
        Status  status;
        string  supersededBy; // CID of the replacement, when superseded
        string  statusReason;
        uint64  statusAt;
    }

    /// @dev cidKey (keccak256 of the CID string) => document.
    mapping(bytes32 => Document) private _documents;
    /// @dev asset => every cidKey anchored against it, in order.
    mapping(bytes32 => bytes32[]) private _byAsset;
    /// @dev SHA-256 digest => cidKey, so the digest alone is enough to look a
    ///      document up. This is also what makes the same bytes un-anchorable
    ///      twice even if someone re-encodes the CID differently.
    mapping(bytes32 => bytes32) private _byDigest;

    bytes32[] private _all;

    /// @notice Who may anchor and revoke. The deployer is the first registrar.
    mapping(address => bool) public registrars;
    address public immutable deployer;

    event DocumentAnchored(
        bytes32 indexed cidKey,
        bytes32 indexed assetId,
        bytes32 indexed sha256Digest,
        string cid,
        string docType,
        address anchoredBy
    );
    event DocumentSuperseded(bytes32 indexed cidKey, string replacementCid, string reason);
    event DocumentRevoked(bytes32 indexed cidKey, string reason, address by);
    event RegistrarChanged(address indexed who, bool allowed);

    error NotRegistrar();
    error AlreadyAnchored(string existingCid, bytes32 assetId);
    error UnknownDocument();
    error NotActive(Status current);
    error EmptyField(string field);

    modifier onlyRegistrar() {
        if (!registrars[msg.sender]) revert NotRegistrar();
        _;
    }

    constructor() {
        deployer = msg.sender;
        registrars[msg.sender] = true;
        emit RegistrarChanged(msg.sender, true);
    }

    /// @notice Add or remove a registrar. Only the deployer, deliberately:
    ///         registrar management is a governance action, not a routine one.
    function setRegistrar(address who, bool allowed) external {
        if (msg.sender != deployer) revert NotRegistrar();
        registrars[who] = allowed;
        emit RegistrarChanged(who, allowed);
    }

    /**
     * @notice Anchor a document's fingerprint.
     * @param assetId      keccak256 of the AasthiChain asset id.
     * @param cid          IPFS CIDv1 of the file.
     * @param sha256Digest SHA-256 of the same bytes.
     * @param docType      Document category.
     * @param validFrom    Unix seconds, 0 for unbounded.
     * @param validTo      Unix seconds, 0 for unbounded.
     *
     * @dev Reverts if these exact bytes are already anchored, naming the asset
     *      that claims them — the same rule the Fabric chaincode applies to
     *      deeds, which is what stops one encumbrance certificate being reused
     *      across several listings.
     */
    function anchor(
        bytes32 assetId,
        string calldata cid,
        bytes32 sha256Digest,
        string calldata docType,
        uint64 validFrom,
        uint64 validTo
    ) external onlyRegistrar returns (bytes32 cidKey) {
        if (bytes(cid).length == 0) revert EmptyField("cid");
        if (sha256Digest == bytes32(0)) revert EmptyField("sha256Digest");
        if (bytes(docType).length == 0) revert EmptyField("docType");

        cidKey = keccak256(bytes(cid));

        // Two independent duplicate checks: by CID and by digest. They catch
        // the same thing from both directions, which matters because a CID can
        // be written in more than one encoding while the digest cannot.
        if (_documents[cidKey].status != Status.NONE) {
            revert AlreadyAnchored(_documents[cidKey].cid, _documents[cidKey].assetId);
        }
        bytes32 existing = _byDigest[sha256Digest];
        if (existing != bytes32(0)) {
            revert AlreadyAnchored(_documents[existing].cid, _documents[existing].assetId);
        }

        _documents[cidKey] = Document({
            assetId: assetId,
            sha256Digest: sha256Digest,
            cid: cid,
            docType: docType,
            anchoredBy: msg.sender,
            anchoredAt: uint64(block.timestamp),
            validFrom: validFrom,
            validTo: validTo,
            status: Status.ACTIVE,
            supersededBy: "",
            statusReason: "",
            statusAt: 0
        });
        _byAsset[assetId].push(cidKey);
        _byDigest[sha256Digest] = cidKey;
        _all.push(cidKey);

        emit DocumentAnchored(cidKey, assetId, sha256Digest, cid, docType, msg.sender);
    }

    /// @notice Mark a document as replaced. The original stays on chain.
    function supersede(string calldata cid, string calldata replacementCid, string calldata reason)
        external
        onlyRegistrar
    {
        bytes32 cidKey = keccak256(bytes(cid));
        Document storage d = _documents[cidKey];
        if (d.status == Status.NONE) revert UnknownDocument();
        if (d.status != Status.ACTIVE) revert NotActive(d.status);
        // The replacement must itself be anchored, or the chain would point at
        // a document nobody can verify.
        if (_documents[keccak256(bytes(replacementCid))].status == Status.NONE) revert UnknownDocument();

        d.status = Status.SUPERSEDED;
        d.supersededBy = replacementCid;
        d.statusReason = reason;
        d.statusAt = uint64(block.timestamp);
        emit DocumentSuperseded(cidKey, replacementCid, reason);
    }

    /// @notice Withdraw a document. Additive: the anchor is untouched.
    function revoke(string calldata cid, string calldata reason) external onlyRegistrar {
        bytes32 cidKey = keccak256(bytes(cid));
        Document storage d = _documents[cidKey];
        if (d.status == Status.NONE) revert UnknownDocument();
        if (d.status != Status.ACTIVE) revert NotActive(d.status);

        d.status = Status.REVOKED;
        d.statusReason = reason;
        d.statusAt = uint64(block.timestamp);
        emit DocumentRevoked(cidKey, reason, msg.sender);
    }

    /**
     * @notice The verification call a third party makes. No gas, no account,
     *         no permission needed — which is the entire point.
     * @return anchored  whether these bytes are on the register
     * @return status    ACTIVE / SUPERSEDED / REVOKED
     * @return expired   whether the validity window has closed
     * @return doc       the full record
     */
    function verify(string calldata cid)
        external
        view
        returns (bool anchored, Status status, bool expired, Document memory doc)
    {
        doc = _documents[keccak256(bytes(cid))];
        anchored = doc.status != Status.NONE;
        status = doc.status;
        expired = doc.validTo != 0 && block.timestamp > doc.validTo;
    }

    /// @notice Verify by SHA-256 alone, the digest the Fabric chaincode holds.
    function verifyDigest(bytes32 sha256Digest)
        external
        view
        returns (bool anchored, Status status, Document memory doc)
    {
        bytes32 cidKey = _byDigest[sha256Digest];
        doc = _documents[cidKey];
        anchored = doc.status != Status.NONE;
        status = doc.status;
    }

    /// @notice Every document anchored against an asset.
    function documentsOf(bytes32 assetId) external view returns (bytes32[] memory) {
        return _byAsset[assetId];
    }

    /// @notice One document by its CID key.
    function get(bytes32 cidKey) external view returns (Document memory) {
        return _documents[cidKey];
    }

    /// @notice Total documents anchored.
    function total() external view returns (uint256) {
        return _all.length;
    }
}
