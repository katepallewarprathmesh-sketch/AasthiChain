#!/bin/bash
set -e

CHANNEL_NAME="property-channel"
CHAINCODE_NAME="aasthichain"
CHAINCODE_VERSION="1.0"
CHAINCODE_PATH="../chaincode"

echo "=== Deploying AasthiChain Chaincode ==="
echo "Channel: $CHANNEL_NAME"
echo "Chaincode: $CHAINCODE_NAME v$CHAINCODE_VERSION"
echo "Endorsement Policies:"
echo "  - MintPropertyTokens: AND('OriginatorMSP.peer','RegistrarMSP.peer')"
echo "  - TransferTokens: OR('InvestorMSP.peer')"
echo "  - FreezeAsset: OR('RegulatorMSP.peer')"

# Package chaincode
echo "Packaging chaincode..."
# peer lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz --path ${CHAINCODE_PATH} --lang golang --label ${CHAINCODE_NAME}_${CHAINCODE_VERSION}

# Install on all peers
echo "Installing on peers..."
# for peer in originator registrar investor regulator; do
#   peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz
# done

# Approve and commit with endorsement policies
echo "Approving chaincode definition..."
# peer lifecycle chaincode approveformyorg -o orderer1.aasthichain:7050 --channelID $CHANNEL_NAME --name $CHAINCODE_NAME --version $CHAINCODE_VERSION --package-id $PACKAGE_ID --sequence 1 --signature-policy "AND('OriginatorMSP.peer','RegistrarMSP.peer')" for mint functions
# In Fabric, endorsement policies are per-chaincode, but we enforce role checks inside chaincode as well (defense in depth)

echo "Chaincode deployed (mock for hackathon demo)"
echo "For local testing: cd ../chaincode && go test -v ./..."
