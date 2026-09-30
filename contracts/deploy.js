// Hardhat deploy script for Sepolia testnet
// Usage: npx hardhat run deploy.js --network sepolia

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying PaymentEscrow with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  const registrarAddress = process.env.REGISTRAR_ADDRESS || deployer.address;
  console.log("Registrar address:", registrarAddress);

  const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
  const escrow = await PaymentEscrow.deploy(registrarAddress);
  
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  
  console.log(`✅ PaymentEscrow deployed to Sepolia at: ${address}`);
  console.log(`   Etherscan: https://sepolia.etherscan.io/address/${address}`);
  console.log(`   Owner: ${deployer.address}`);
  console.log(`   Registrar: ${registrarAddress}`);
  console.log(`\nAdd to frontend .env:`);
  console.log(`VITE_ESCROW_CONTRACT_ADDRESS=${address}`);
  console.log(`VITE_SEPOLIA_RPC_URL=${process.env.SEPOLIA_RPC_URL}`);
  console.log(`\nTest with 0.01 SepoliaETH:`);
  console.log(`- Get faucet: https://sepoliafaucet.com/`);
  console.log(`- Initiate payment via frontend TestnetPayment component`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
