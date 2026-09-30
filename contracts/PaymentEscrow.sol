// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AasthiChain Payment Escrow — Sepolia Testnet
 * @notice Escrow for fractional real estate purchases — testnet money involvement
 * @dev Drunix holds property tokens (permissioned), Sepolia holds payment (test ETH)
 *      This enables atomic DvP (Delivery vs Payment) demo with real testnet transactions
 *      No real money — uses Sepolia test ETH from faucet
 */

contract PaymentEscrow {
    struct Payment {
        bytes32 assetId; // PROP-... hashed as bytes32
        address from;
        address to; // originator's wallet (mapped off-chain)
        uint256 amount; // in wei (test ETH)
        uint256 tokenAmount; // number of property tokens
        uint256 createdAt;
        Status status;
        string drunixTransferId; // TXN-... from Drunix after token transfer
    }

    enum Status { PENDING, CONFIRMED, RELEASED, REFUNDED, FAILED }

    mapping(bytes32 => Payment) public payments; // paymentId => Payment
    mapping(address => bytes32[]) public paymentsByUser;

    event PaymentInitiated(bytes32 indexed paymentId, bytes32 indexed assetId, address from, address to, uint256 amount, uint256 tokenAmount);
    event PaymentConfirmed(bytes32 indexed paymentId, string drunixTransferId);
    event PaymentReleased(bytes32 indexed paymentId, address to, uint256 amount);
    event PaymentRefunded(bytes32 indexed paymentId, address from, uint256 amount);

    address public owner;
    address public registrar; // Registrar org can confirm/reject

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyRegistrar() {
        require(msg.sender == registrar || msg.sender == owner, "Not registrar");
        _;
    }

    constructor(address _registrar) {
        owner = msg.sender;
        registrar = _registrar;
    }

    /**
     * @notice Investor initiates payment for tokens — locks test ETH in escrow
     * @param assetId bytes32 of property assetId (keccak256 of PROP-...)
     * @param to address of originator (off-chain mapping from originatorId)
     * @param tokenAmount number of property tokens being purchased
     */
    function initiatePayment(bytes32 assetId, address to, uint256 tokenAmount) external payable {
        require(msg.value > 0, "Amount must be > 0");
        require(msg.value >= 0.001 ether, "Min 0.001 ETH for Sepolia gas/dust — faucet gives 0.5 free, ensures valid tx, fixes min balance 0.001 error. For tiny amounts, frontend enforces min 0.001 via Math.max().");
        require(to != address(0), "Invalid to");
        require(tokenAmount > 0, "Token amount must be > 0");
        require(to != msg.sender, "Self payment not allowed");

        bytes32 paymentId = keccak256(abi.encodePacked(assetId, msg.sender, to, msg.value, tokenAmount, block.timestamp));

        payments[paymentId] = Payment({
            assetId: assetId,
            from: msg.sender,
            to: to,
            amount: msg.value,
            tokenAmount: tokenAmount,
            createdAt: block.timestamp,
            status: Status.PENDING,
            drunixTransferId: ""
        });

        paymentsByUser[msg.sender].push(paymentId);
        paymentsByUser[to].push(paymentId);

        emit PaymentInitiated(paymentId, assetId, msg.sender, to, msg.value, tokenAmount);
    }

    /**
     * @notice Registrar or backend confirms Drunix token transfer succeeded — links TXN ID
     * @param paymentId paymentId from initiatePayment
     * @param drunixTransferId TXN-... from Drunix TransferTokens
     */
    function confirmDrunixTransfer(bytes32 paymentId, string calldata drunixTransferId) external onlyRegistrar {
        Payment storage p = payments[paymentId];
        require(p.amount > 0, "Payment not found");
        require(p.status == Status.PENDING, "Not pending");
        require(bytes(drunixTransferId).length > 0, "Invalid transferId");

        p.drunixTransferId = drunixTransferId;
        p.status = Status.CONFIRMED;

        emit PaymentConfirmed(paymentId, drunixTransferId);
    }

    /**
     * @notice Release escrowed test ETH to originator after Drunix transfer confirmed — atomic DvP
     */
    function releasePayment(bytes32 paymentId) external onlyRegistrar {
        Payment storage p = payments[paymentId];
        require(p.amount > 0, "Payment not found");
        require(p.status == Status.CONFIRMED, "Not confirmed — need Drunix TXN first");
        require(bytes(p.drunixTransferId).length > 0, "No Drunix transfer linked");

        p.status = Status.RELEASED;
        (bool success, ) = p.to.call{value: p.amount}("");
        require(success, "Transfer failed");

        emit PaymentReleased(paymentId, p.to, p.amount);
    }

    /**
     * @notice Refund investor if Drunix transfer fails or registrar rejects
     */
    function refundPayment(bytes32 paymentId) external onlyRegistrar {
        Payment storage p = payments[paymentId];
        require(p.amount > 0, "Payment not found");
        require(p.status == Status.PENDING || p.status == Status.CONFIRMED, "Cannot refund");

        p.status = Status.REFUNDED;
        (bool success, ) = p.from.call{value: p.amount}("");
        require(success, "Refund failed");

        emit PaymentRefunded(paymentId, p.from, p.amount);
    }

    /**
     * @notice Get payments by user
     */
    function getPaymentsByUser(address user) external view returns (bytes32[] memory) {
        return paymentsByUser[user];
    }

    /**
     * @notice Get payment details
     */
    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }

    // Emergency
    function setRegistrar(address _registrar) external onlyOwner {
        registrar = _registrar;
    }

    receive() external payable {}
}
