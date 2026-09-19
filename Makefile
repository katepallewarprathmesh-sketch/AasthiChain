.PHONY: network chaincode api frontend test clean

network:
	cd network && docker-compose up -d
	@echo "Network started. Waiting for postgres health..."
	sleep 5
	cd network && ./scripts/create-channel.sh
	cd network && ./scripts/deploy-chaincode.sh

chaincode-test:
	cd chaincode && go test -v ./...

api:
	cd api-gateway && go mod tidy && go run main.go

frontend:
	cd frontend && npm install && npm run dev

test: chaincode-test
	@echo "All tests passed"

clean:
	cd network && docker-compose down -v
	rm -rf network/crypto-config network/channel-artifacts

demo: chaincode-test
	@echo "=== AasthiChain Demo Ready ==="
	@echo "API Gateway: http://localhost:8080/health"
	@echo "Frontend: http://localhost:5173"
	@echo "Login presets: originator1, registrar1, investor1, investor2, regulator1"
