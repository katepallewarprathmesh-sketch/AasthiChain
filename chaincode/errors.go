package main

import "fmt"

const (
	ErrInsufficientBalance = "ERR_INSUFFICIENT_BALANCE"
	ErrInvalidTransfer     = "ERR_INVALID_TRANSFER"
	ErrKYCNotVerified      = "ERR_KYC_NOT_VERIFIED"
	ErrInvalidAmount       = "ERR_INVALID_AMOUNT"
	ErrUnauthorized        = "ERR_UNAUTHORIZED"
	ErrAssetFrozen         = "ERR_ASSET_FROZEN"
	ErrAssetNotFound       = "ERR_ASSET_NOT_FOUND"
	ErrAlreadyTokenized    = "ERR_ALREADY_TOKENIZED"
	ErrNotValidated        = "ERR_NOT_VALIDATED"
	ErrInvalidInput        = "ERR_INVALID_INPUT"
	ErrDuplicateMint       = "ERR_DUPLICATE_MINT"
	ErrOverflow            = "ERR_OVERFLOW"
	ErrBalanceNotFound     = "ERR_BALANCE_NOT_FOUND"
	ErrDuplicateProperty   = "ERR_DUPLICATE_PROPERTY"
)

type ChaincodeError struct {
	Code    string
	Message string
}

func (e *ChaincodeError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func NewError(code, msg string) *ChaincodeError {
	return &ChaincodeError{Code: code, Message: msg}
}
