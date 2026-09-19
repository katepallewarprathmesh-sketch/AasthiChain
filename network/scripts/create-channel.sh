#!/bin/bash
set -e

echo "=== AasthiChain Network Setup ==="
echo "Creating crypto material (mock for hackathon)..."
mkdir -p crypto-config/peerOrganizations/originator.aasthichain.com/msp
mkdir -p crypto-config/peerOrganizations/registrar.aasthichain.com/msp
mkdir -p crypto-config/peerOrganizations/investor.aasthichain.com/msp
mkdir -p crypto-config/peerOrganizations/regulator.aasthichain.com/msp
mkdir -p crypto-config/ordererOrganizations/aasthichain.com/msp
mkdir -p channel-artifacts

# In production, use cryptogen or Fabric CA to generate MSP
# For hackathon demo, we create placeholder structure
echo "NOTE: In real deployment, Fabric CA would issue certs for 4 orgs"
echo "For hackathon, docker-compose up starts the network with mock MSP"

echo "Creating genesis block..."
# configtxgen -profile AasthiChainGenesis -channelID system-channel -outputBlock ./channel-artifacts/genesis.block
echo "Genesis block would be created here via configtxgen"

echo "Creating property-channel transaction..."
# configtxgen -profile PropertyChannel -outputCreateChannelTx ./channel-artifacts/property-channel.tx -channelID property-channel
echo "Channel tx would be created here"

echo "=== Channel Creation Steps (for real Fabric) ==="
echo "1. docker-compose up -d"
echo "2. docker exec peer0.originator.aasthichain peer channel create -o orderer1.aasthichain:7050 -c property-channel -f ./channel-artifacts/property-channel.tx"
echo "3. Join all peers to property-channel"
echo "4. Deploy chaincode with endorsement policy AND('OriginatorMSP.peer','RegistrarMSP.peer') for Mint"
echo ""
echo "For hackathon demo, API gateway uses MockFabricClient that simulates these steps"
echo "See chaincode/ for actual chaincode logic with full edge case handling"
