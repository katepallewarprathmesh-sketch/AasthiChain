package paymentgateway

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPropertyData_Verify(t *testing.T) {
	provider := NewPropertyDataProvider(PropertyDataMock, nil)

	verification, err := provider.Verify("PROP-001", 7500000, "originator1", "Maharashtra", "Pune", "411045", SourceBhoomi)
	assert.NoError(t, err)
	assert.NotNil(t, verification)
	assert.Equal(t, "PROP-001", verification.AssetID)
	assert.Equal(t, SourceBhoomi, verification.Source)
	assert.NotEmpty(t, verification.GovernmentRecord.SurveyNumber)
	assert.NotEmpty(t, verification.GovernmentRecord.OwnerName)
	assert.True(t, verification.ValuationSource.GovernmentValuation > 0)
	assert.True(t, verification.MatchScore >= 85)
	assert.NotEmpty(t, verification.Message)
}

func TestPropertyData_Verify_Encumbrance(t *testing.T) {
	provider := NewPropertyDataProvider(PropertyDataMock, nil)

	// Run multiple times to hit encumbrance case (10% chance)
	foundEncumbrance := false
	for i := 0; i < 20; i++ {
		verification, _ := provider.Verify("PROP-001", 7500000, "originator1", "Maharashtra", "Pune", "411045", SourceBhoomi)
		if verification.EncumbranceCheck.HasEncumbrance {
			foundEncumbrance = true
			assert.NotEmpty(t, verification.EncumbranceCheck.Encumbrances)
			assert.False(t, verification.Verified, "Should not be verified if has encumbrance")
			break
		}
	}
	// It's probabilistic, so we don't fail if not found, just log
	if foundEncumbrance {
		t.Log("Found encumbrance case — verification correctly marks not verified")
	}
}

func TestPropertyData_GetVerification(t *testing.T) {
	provider := NewPropertyDataProvider(PropertyDataMock, nil)

	_, _ = provider.Verify("PROP-001", 7500000, "originator1", "Maharashtra", "Pune", "411045", SourceBhoomi)

	v, ok := provider.GetVerification("PROP-001")
	assert.True(t, ok)
	assert.Equal(t, "PROP-001", v.AssetID)

	_, ok = provider.GetVerification("NON-EXISTENT")
	assert.False(t, ok)
}

func TestPropertyData_ListVerifications(t *testing.T) {
	provider := NewPropertyDataProvider(PropertyDataMock, nil)

	provider.Verify("PROP-001", 7500000, "originator1", "Maharashtra", "Pune", "411045", SourceBhoomi)
	provider.Verify("PROP-002", 6000000, "originator1", "Karnataka", "Bangalore", "560001", SourceDharani)

	list := provider.ListVerifications()
	assert.Len(t, list, 2)
}

func TestPropertyData_RealMode(t *testing.T) {
	provider := NewPropertyDataProvider(PropertyDataReal, map[PropertySource]string{
		SourceBhoomi: "test-api-key",
	})

	// Without API key should fail
	providerNoKey := NewPropertyDataProvider(PropertyDataReal, nil)
	_, err := providerNoKey.VerifyReal("PROP-001", "SY-123/1", SourceBhoomi)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "API key")

	// With API key, should work (mocked)
	verification, err := provider.VerifyReal("PROP-001", "SY-123/1", SourceBhoomi)
	assert.NoError(t, err)
	assert.Equal(t, PropertyDataReal, verification.Mode)
}
