package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func main() {
	// Multiple contracts in single chaincode package as per spec: property.go, token.go, kyc.go
	propertyContract := new(PropertyContract)
	tokenContract := new(TokenContract)
	kycContract := new(KYCContract)

	chaincode, err := contractapi.NewChaincode(propertyContract, tokenContract, kycContract)
	if err != nil {
		log.Panicf("Error creating AasthiChain chaincode: %v", err)
	}

	if err := chaincode.Start(); err != nil {
		log.Panicf("Error starting AasthiChain chaincode: %v", err)
	}
}
