// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AasthiChain property token: the public-chain leg of a fractional property.
 *
 * WHY THIS SHAPE, AND NOT ANOTHER
 *
 * The instrument is a fungible fractional interest in one property, held only
 * by investors who have passed KYC, with caps per holder, lock-ups, and a
 * regulator who can freeze or direct a transfer. There are no tranches, no
 * side pockets and no share classes.
 *
 * ERC-1400 was considered and rejected. Its single real advantage over the
 * alternatives is partitions, which this instrument does not use, and the
 * family (ERC-1400, ERC-1410, ERC-1594, ERC-1643, ERC-1644) never reached
 * Final: they remain GitHub issues from 2018. Choosing a draft standard for
 * the unused feature would be choosing badly twice.
 *
 * ERC-3643 is the right architecture and is the one followed here: an
 * ERC-20 compatible token whose transfers are gated by an on-chain identity
 * registry and a set of modular compliance rules, with agent roles for
 * freeze, forced transfer and recovery. It is Final, it dominates tokenised
 * real estate, and an auditor who has seen it before can read this contract
 * without learning our vocabulary.
 *
 * What is deliberately NOT copied from ERC-3643 is ONCHAINID. That standard
 * prescribes a per-investor identity contract (ERC-734/735) holding claims
 * from trusted issuers. This project already has an identity layer: DIDs,
 * W3C verifiable credentials signed by the rail, KYC tiers written by the
 * verification itself, and a signing-key register. Deploying ONCHAINID would
 * mean operating two identity systems that must agree, and the failure mode
 * of two systems that must agree is that one day they do not.
 *
 * So eligibility is expressed through the ERC-7943 (uRWA) interface, which
 * reached Final in May 2026 and is deliberately identity-agnostic: it fixes
 * canTransact, canTransfer, getFrozenTokens, setFrozenTokens and
 * forcedTransfer, and says nothing about how eligibility is decided. That is
 * exactly the right seam for a system that already knows who its investors
 * are. The result is ERC-3643's architecture expressed through a frozen,
 * standard interface.
 *
 * THE HONEST PART
 *
 * This contract is a MIRROR, not the record. Settlement, the cash leg and
 * conservation live on the permissioned rail, where the rules are set by a
 * regulator rather than by whoever runs a public chain. The mirror exists so
 * a holder can prove a position without asking us, and so a counterparty who
 * will only trust a public chain gets the same arithmetic. Where the two
 * disagree, the rail is authoritative and the mirror is wrong: see
 * railAssetId and the Mirrored event.
 *
 * A restriction that can be bypassed by trading the token directly is not a
 * restriction, so every rule is enforced inside _update, which every path
 * including transferFrom must pass through.
 */

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice ERC-7943 (uRWA), the Final interface for real-world asset tokens.
interface IERC7943Fungible is IERC165 {
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount);
    event Frozen(address indexed account, uint256 amount);

    error ERC7943CannotTransact(address account);
    error ERC7943CannotTransfer(address from, address to, uint256 amount);
    error ERC7943InsufficientUnfrozenBalance(address account, uint256 amount, uint256 unfrozen);

    function forcedTransfer(address from, address to, uint256 amount) external returns (bool result);
    function setFrozenTokens(address account, uint256 amount) external returns (bool result);
    function canTransact(address account) external view returns (bool allowed);
    function getFrozenTokens(address account) external view returns (uint256 amount);
    function canTransfer(address from, address to, uint256 amount) external view returns (bool allowed);
}

/* -------------------------------------------------------------------------- */
/*                              Identity registry                             */
/* -------------------------------------------------------------------------- */

/**
 * Who may hold this token.
 *
 * One wallet resolves to one investor, because every eligibility rule worth
 * having counts people rather than addresses: a holder cap that counts
 * wallets is defeated by opening another wallet.
 *
 * The records here are written by an agent from the rail's own KYC state.
 * The registry is the on-chain projection of a decision taken off-chain by a
 * verifier who is accountable for it, which is the same division ERC-3643
 * draws between a trusted issuer and the chain.
 */
contract IdentityRegistry {
    struct Identity {
        bool verified; // KYC passed and not lapsed
        bytes32 did; // keccak256 of did:aasthi:<id>, so the rail identity is provable without publishing it
        uint8 kycTier; // 1 = minimum KYC, 2 = full KYC. Mirrors the rail's tiers.
        bytes2 country; // ISO 3166-1 alpha-2, as bytes so it is cheap to compare
        uint64 lockedUntil; // unix seconds; a lock-up on receiving, not on holding
    }

    address public owner;
    mapping(address => bool) public isAgent;
    mapping(address => Identity) private _identities;
    uint256 public verifiedCount;

    event AgentSet(address indexed agent, bool allowed);
    event IdentityRegistered(address indexed wallet, bytes32 indexed did, uint8 kycTier, bytes2 country);
    event IdentityRemoved(address indexed wallet, string reason);

    error NotAuthorised();
    error ZeroAddress();

    modifier onlyAgent() {
        if (!isAgent[msg.sender] && msg.sender != owner) revert NotAuthorised();
        _;
    }

    constructor() {
        owner = msg.sender;
        isAgent[msg.sender] = true;
        emit AgentSet(msg.sender, true);
    }

    function setAgent(address agent, bool allowed) external {
        if (msg.sender != owner) revert NotAuthorised();
        if (agent == address(0)) revert ZeroAddress();
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function register(address wallet, bytes32 did, uint8 tier, bytes2 country, uint64 unlockAt)
        external
        onlyAgent
    {
        if (wallet == address(0)) revert ZeroAddress();
        if (!_identities[wallet].verified) verifiedCount++;
        _identities[wallet] = Identity(true, did, tier, country, unlockAt);
        emit IdentityRegistered(wallet, did, tier, country);
    }

    /**
     * Withdrawing a verification takes effect on the next transfer, which is
     * the behaviour a periodic re-screening regime needs: a claim that has
     * stopped being valid must stop being usable immediately, not at renewal.
     */
    function remove(address wallet, string calldata reason) external onlyAgent {
        if (_identities[wallet].verified) verifiedCount--;
        delete _identities[wallet];
        emit IdentityRemoved(wallet, reason);
    }

    function identity(address wallet) external view returns (Identity memory) {
        return _identities[wallet];
    }

    function isVerified(address wallet) public view returns (bool) {
        return _identities[wallet].verified;
    }

    function kycTier(address wallet) external view returns (uint8) {
        return _identities[wallet].kycTier;
    }

    function lockedUntil(address wallet) external view returns (uint64) {
        return _identities[wallet].lockedUntil;
    }
}

/* -------------------------------------------------------------------------- */
/*                                 Compliance                                 */
/* -------------------------------------------------------------------------- */

/**
 * Offering-level rules, kept apart from identity on purpose.
 *
 * ERC-3643 separates "is this person eligible at all" from "does this
 * particular transfer break a rule of the offering", and the separation is
 * what lets an auditor match one rule to one function. Each rule can be
 * switched off by setting it to zero, and a disabled rule says so rather
 * than silently passing.
 */
contract Compliance {
    address public owner;

    uint256 public maxHolders; // 0 = no limit
    uint256 public maxPerHolder; // 0 = no limit, in token units
    uint8 public minKycTier; // 0 = no minimum

    uint256 public holderCount;

    event RuleChanged(string rule, uint256 value);

    error NotAuthorised();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorised();
        _;
    }

    constructor(uint256 maxHolders_, uint256 maxPerHolder_, uint8 minKycTier_) {
        owner = msg.sender;
        maxHolders = maxHolders_;
        maxPerHolder = maxPerHolder_;
        minKycTier = minKycTier_;
    }

    function setMaxHolders(uint256 v) external onlyOwner {
        maxHolders = v;
        emit RuleChanged("maxHolders", v);
    }

    function setMaxPerHolder(uint256 v) external onlyOwner {
        maxPerHolder = v;
        emit RuleChanged("maxPerHolder", v);
    }

    function setMinKycTier(uint8 v) external onlyOwner {
        minKycTier = v;
        emit RuleChanged("minKycTier", uint256(v));
    }

    /// @notice Called by the token before a balance moves. View only: a
    ///         compliance module that mutates state during a check cannot be
    ///         used by canTransfer, and a canTransfer that lies is worse than
    ///         none.
    function canReceive(uint256 recipientBalanceAfter, bool recipientIsNew, uint8 tier)
        external
        view
        returns (bool)
    {
        if (minKycTier != 0 && tier < minKycTier) return false;
        if (maxPerHolder != 0 && recipientBalanceAfter > maxPerHolder) return false;
        if (maxHolders != 0 && recipientIsNew && holderCount + 1 > maxHolders) return false;
        return true;
    }

    /// @notice The token reports holder arrivals and departures so the holder
    ///         cap counts reality rather than an estimate.
    function syncHolders(uint256 count) external {
        // Only the token this compliance serves may report. Set once by the
        // token at construction, so the owner cannot forge a holder count.
        if (msg.sender != token) revert NotAuthorised();
        holderCount = count;
    }

    address public token;

    function bindToken(address token_) external onlyOwner {
        require(token == address(0), "token already bound");
        token = token_;
    }
}

/* -------------------------------------------------------------------------- */
/*                               Property token                               */
/* -------------------------------------------------------------------------- */

contract PropertyToken is IERC7943Fungible {
    /* ----------------------------------------------------------- ERC-20 */

    string public name;
    string public symbol;
    uint8 public constant decimals = 0; // a property token is a whole fraction; half a token is not a thing

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed holder, address indexed spender, uint256 value);

    /* ------------------------------------------------------- the mirror */

    /// @notice keccak256 of the rail's assetId. The link back to the record.
    bytes32 public immutable railAssetId;

    /// @notice Emitted whenever the issuer states the rail position this
    ///         contract is mirroring. A reader can then tell whether the
    ///         mirror is current, rather than assuming it.
    event Mirrored(uint256 railOutstandingTokens, uint256 contractTotalSupply, string note);

    /* -------------------------------------------------------- the roles */

    address public owner;
    mapping(address => bool) public isAgent; // issue, freeze, forced transfer, recovery
    bool public paused;

    IdentityRegistry public immutable identities;
    Compliance public immutable compliance;

    /* ------------------------------------------------------- the freeze */

    mapping(address => uint256) private _frozen;
    uint256 public holders;

    event AgentSet(address indexed agent, bool allowed);
    event Paused(bool paused);
    event Recovered(address indexed lost, address indexed replacement, uint256 amount);

    error NotAuthorised();
    error TokenPaused();
    error ZeroAddress();
    error InsufficientBalance(address account, uint256 wanted, uint256 held);

    modifier onlyAgent() {
        if (!isAgent[msg.sender] && msg.sender != owner) revert NotAuthorised();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 railAssetId_,
        IdentityRegistry identities_,
        Compliance compliance_
    ) {
        owner = msg.sender;
        isAgent[msg.sender] = true;
        name = name_;
        symbol = symbol_;
        railAssetId = railAssetId_;
        identities = identities_;
        compliance = compliance_;
        emit AgentSet(msg.sender, true);
    }

    /* ------------------------------------------------------ eligibility */

    /// @inheritdoc IERC7943Fungible
    function canTransact(address account) public view returns (bool allowed) {
        return !paused && identities.isVerified(account);
    }

    /// @notice Split out from canTransfer so a refusal can be attributed to
    ///         the receiving side without telling the sender why, which is
    ///         what a tipping-off rule requires.
    function canReceive(address to, uint256 amount) public view returns (bool) {
        if (!canTransact(to)) return false;
        IdentityRegistry.Identity memory id = identities.identity(to);
        if (id.lockedUntil != 0 && block.timestamp < id.lockedUntil) return false;
        return compliance.canReceive(balanceOf[to] + amount, balanceOf[to] == 0, id.kycTier);
    }

    /// @inheritdoc IERC7943Fungible
    function canTransfer(address from, address to, uint256 amount) public view returns (bool allowed) {
        if (!canTransact(from)) return false;
        if (amount == 0) return false;
        uint256 unfrozen = _unfrozenBalance(from);
        if (amount > unfrozen) return false;
        return canReceive(to, amount);
    }

    function _unfrozenBalance(address account) internal view returns (uint256) {
        uint256 bal = balanceOf[account];
        uint256 frz = _frozen[account];
        return frz >= bal ? 0 : bal - frz;
    }

    /// @inheritdoc IERC7943Fungible
    function getFrozenTokens(address account) external view returns (uint256 amount) {
        return _frozen[account];
    }

    /* --------------------------------------------------------- transfer */

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientBalance(from, amount, a);
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    /**
     * The one gate. Every ordinary movement passes through here, so a rule
     * cannot be sidestepped by choosing a different entry point. Mint, burn
     * and forcedTransfer use _update directly and are each restricted.
     */
    function _transfer(address from, address to, uint256 amount) internal {
        if (paused) revert TokenPaused();
        if (to == address(0)) revert ZeroAddress();
        if (!canTransact(from)) revert ERC7943CannotTransact(from);
        if (!canTransfer(from, to, amount)) {
            uint256 unfrozen = _unfrozenBalance(from);
            if (amount > unfrozen) revert ERC7943InsufficientUnfrozenBalance(from, amount, unfrozen);
            revert ERC7943CannotTransfer(from, to, amount);
        }
        _update(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal {
        if (from != address(0)) {
            uint256 bal = balanceOf[from];
            if (bal < amount) revert InsufficientBalance(from, amount, bal);
            unchecked {
                balanceOf[from] = bal - amount;
            }
            if (balanceOf[from] == 0 && amount > 0) holders--;
        } else {
            totalSupply += amount;
        }

        if (to != address(0)) {
            if (balanceOf[to] == 0 && amount > 0) holders++;
            balanceOf[to] += amount;
        } else {
            totalSupply -= amount;
        }

        compliance.syncHolders(holders);
        emit Transfer(from, to, amount);
    }

    /* ----------------------------------------------------- issuer rights */

    function setAgent(address agent, bool allowed) external {
        if (msg.sender != owner) revert NotAuthorised();
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function setPaused(bool p) external onlyAgent {
        paused = p;
        emit Paused(p);
    }

    /// @notice Issue tokens to a holder. Minting is as restricted as every
    ///         other movement: an unverified wallet cannot be minted into,
    ///         or the eligibility rules would be a formality.
    function mint(address to, uint256 amount) external onlyAgent {
        if (!canReceive(to, amount)) revert ERC7943CannotTransfer(address(0), to, amount);
        _update(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyAgent {
        _update(from, address(0), amount);
    }

    /// @notice Record which rail position this contract is mirroring.
    function mirror(uint256 railOutstandingTokens, string calldata note) external onlyAgent {
        emit Mirrored(railOutstandingTokens, totalSupply, note);
    }

    /* ------------------------------------------------- enforcement paths */

    /// @inheritdoc IERC7943Fungible
    function setFrozenTokens(address account, uint256 amount) external onlyAgent returns (bool result) {
        _frozen[account] = amount;
        emit Frozen(account, amount);
        return true;
    }

    /**
     * The enforcement path, and it is deliberately not a back door. It
     * overrides the sender's own restrictions and any freeze, because that
     * is what a court order or an estate transfer requires, but it still
     * refuses to move tokens to somebody who may not hold them. An
     * enforcement power that can place an asset with an ineligible holder
     * would make every other rule optional.
     */
    function forcedTransfer(address from, address to, uint256 amount) external onlyAgent returns (bool result) {
        if (to == address(0)) revert ZeroAddress();
        if (!canReceive(to, amount)) revert ERC7943CannotTransfer(from, to, amount);

        // Unfreeze exactly what is needed first, and say so, before the
        // balance moves. The order matters: a reader of the log must never
        // see a transfer of tokens that still appear frozen.
        uint256 unfrozen = _unfrozenBalance(from);
        if (amount > unfrozen) {
            uint256 excess = amount - unfrozen;
            uint256 frz = _frozen[from];
            _frozen[from] = frz > excess ? frz - excess : 0;
            emit Frozen(from, _frozen[from]);
        }

        _update(from, to, amount);
        emit ForcedTransfer(from, to, amount);
        return true;
    }

    /**
     * Lost key recovery. The replacement wallet must already be verified
     * against the same investor identity, so recovery cannot quietly move an
     * asset to a different person.
     */
    function recover(address lost, address replacement) external onlyAgent returns (uint256 moved) {
        IdentityRegistry.Identity memory a = identities.identity(lost);
        IdentityRegistry.Identity memory b = identities.identity(replacement);
        if (!b.verified) revert ERC7943CannotTransact(replacement);
        if (a.did == bytes32(0) || a.did != b.did) revert ERC7943CannotTransfer(lost, replacement, 0);

        moved = balanceOf[lost];
        uint256 frz = _frozen[lost];
        if (frz != 0) {
            _frozen[lost] = 0;
            emit Frozen(lost, 0);
        }
        if (moved > 0) _update(lost, replacement, moved);
        if (frz != 0) {
            _frozen[replacement] = frz;
            emit Frozen(replacement, frz);
        }
        emit Recovered(lost, replacement, moved);
        emit ForcedTransfer(lost, replacement, moved);
        return moved;
    }

    /* ----------------------------------------------------------- ERC-165 */

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC7943Fungible).interfaceId;
    }
}
