package paymentgateway

import (
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// Property Data Verification — Government land records
// Sources: Bhoomi (Karnataka), Dharani (Telangana), e-Property/Mahabhulekh (Maharashtra)
// Via state data centers or Setu AA (Account Aggregator)
// Mock for hackathon, real toggle via PROPERTY_DATA_API_KEY

type PropertyDataMode string

const (
	PropertyDataMock PropertyDataMode = "mock"
	PropertyDataReal PropertyDataMode = "real"
)

type PropertySource string

const (
	SourceBhoomi     PropertySource = "bhoomi"
	SourceDharani    PropertySource = "dharani"
	SourceMahabhulekh PropertySource = "mahabhulekh"
	SourceEProperty  PropertySource = "e-property"
)

type GovernmentRecord struct {
	SurveyNumber       string    `json:"surveyNumber"`
	OwnerName          string    `json:"ownerName"`
	OwnerAadhaar       string    `json:"ownerAadhaar"`
	Location           struct {
		State   string `json:"state"`
		City    string `json:"city"`
		Pincode string `json:"pincode"`
	} `json:"location"`
	AreaSqFt           int       `json:"areaSqFt"`
	GovernmentValuation int64    `json:"governmentValuation"`
	LastTransaction    time.Time `json:"lastTransaction"`
	Source             PropertySource `json:"source"`
}

type Encumbrance struct {
	Type   string    `json:"type"` // Mortgage, Litigation, etc
	Bank   string    `json:"bank,omitempty"`
	Amount int64     `json:"amount,omitempty"`
	Date   time.Time `json:"date"`
}

type Litigation struct {
	CaseNo string `json:"caseNo"`
	Court  string `json:"court"`
	Status string `json:"status"`
}

type EncumbranceCheck struct {
	HasEncumbrance bool         `json:"hasEncumbrance"`
	Encumbrances   []Encumbrance `json:"encumbrances"`
	Litigation     []Litigation  `json:"litigation"`
	CheckedAt      time.Time    `json:"checkedAt"`
}

type ValuationSource struct {
	OurValuation        int64   `json:"ourValuation"`
	GovernmentValuation int64   `json:"governmentValuation"`
	DifferencePercent   float64 `json:"differencePercent"`
	Source              string  `json:"source"`
	LastUpdated         time.Time `json:"lastUpdated"`
}

type PropertyVerification struct {
	AssetID            string            `json:"assetId"`
	Verified           bool              `json:"verified"`
	MatchScore         int               `json:"matchScore"` // 0-100
	GovernmentRecord   GovernmentRecord  `json:"governmentRecord"`
	EncumbranceCheck   EncumbranceCheck  `json:"encumbranceCheck"`
	ValuationSource    ValuationSource   `json:"valuationSource"`
	Source             PropertySource    `json:"source"`
	Mode               PropertyDataMode  `json:"mode"`
	VerifiedAt         time.Time         `json:"verifiedAt"`
	Message            string            `json:"message"`
}

type PropertyDataProvider struct {
	mu            sync.RWMutex
	verifications map[string]*PropertyVerification // assetId -> verification
	mode          PropertyDataMode
	apiKeys       map[PropertySource]string
}

func NewPropertyDataProvider(mode PropertyDataMode, apiKeys map[PropertySource]string) *PropertyDataProvider {
	if mode == "" {
		mode = PropertyDataMock
	}
	if apiKeys == nil {
		apiKeys = make(map[PropertySource]string)
	}
	return &PropertyDataProvider{
		verifications: make(map[string]*PropertyVerification),
		mode:          mode,
		apiKeys:       apiKeys,
	}
}

// Verify — checks property against government land records
// Real flow: assetId -> survey number -> API call to Bhoomi/Dharani -> government record -> compare
func (p *PropertyDataProvider) Verify(assetID string, ourValuation int64, originatorID, state, city, pincode string, source PropertySource) (*PropertyVerification, error) {
	if assetID == "" {
		return nil, errors.New("assetId required")
	}
	if source == "" {
		source = SourceBhoomi
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Mock government record — realistic
	rand.Seed(time.Now().UnixNano())
	govValuation := int64(float64(ourValuation) * (0.9 + rand.Float64()*0.2)) // 90-110% of our valuation

	govRecord := GovernmentRecord{
		SurveyNumber:       fmt.Sprintf("SY-%04d/%d", rand.Intn(9000)+1000, rand.Intn(9)+1),
		OwnerName:          fmt.Sprintf("%s Kumar", originatorID),
		OwnerAadhaar:       "XXXX-XXXX-1234",
		AreaSqFt:           rand.Intn(2000) + 500,
		GovernmentValuation: govValuation,
		LastTransaction:    time.Now().AddDate(0, -rand.Intn(12), -rand.Intn(30)),
		Source:             source,
	}
	govRecord.Location.State = state
	govRecord.Location.City = city
	govRecord.Location.Pincode = pincode

	// Encumbrance check — 10% chance has encumbrance for demo
	hasEncumbrance := rand.Float64() < 0.1
	var encumbrances []Encumbrance
	var litigations []Litigation

	if hasEncumbrance {
		encumbrances = []Encumbrance{
			{
				Type:   "Mortgage",
				Bank:   "SBI",
				Amount: 2000000,
				Date:   time.Now().AddDate(-1, 0, 0),
			},
		}
	}
	if rand.Float64() < 0.05 {
		litigations = []Litigation{
			{
				CaseNo: fmt.Sprintf("CS/%d/2024", rand.Intn(900)+100),
				Court:  fmt.Sprintf("%s District Court", city),
				Status: "Pending",
			},
		}
		hasEncumbrance = hasEncumbrance || len(litigations) > 0
	}

	encCheck := EncumbranceCheck{
		HasEncumbrance: hasEncumbrance,
		Encumbrances:   encumbrances,
		Litigation:     litigations,
		CheckedAt:      time.Now(),
	}

	diffPercent := float64(govValuation-ourValuation) / float64(ourValuation) * 100
	valuation := ValuationSource{
		OurValuation:        ourValuation,
		GovernmentValuation: govValuation,
		DifferencePercent:   diffPercent,
		Source:              fmt.Sprintf("%s circle rate", source),
		LastUpdated:         time.Now(),
	}

	matchScore := 85 + rand.Intn(15) // 85-100%
	verified := !hasEncumbrance && matchScore > 80

	var message string
	if verified {
		message = fmt.Sprintf("✓ Verified with %s — ownership matches, no encumbrance, valuation within %.1f%%", source, diffPercent)
	} else if hasEncumbrance {
		encType := "unknown"
		if len(encumbrances) > 0 {
			encType = encumbrances[0].Type
		}
		message = fmt.Sprintf("⚠️ Encumbrance found — %s — Registrar should REJECT per §3.2", encType)
	} else {
		message = fmt.Sprintf("Ownership match %d%% — review needed", matchScore)
	}

	verification := &PropertyVerification{
		AssetID:          assetID,
		Verified:         verified,
		MatchScore:       matchScore,
		GovernmentRecord: govRecord,
		EncumbranceCheck: encCheck,
		ValuationSource:  valuation,
		Source:           source,
		Mode:             p.mode,
		VerifiedAt:       time.Now(),
		Message:          message,
	}

	p.verifications[assetID] = verification
	return verification, nil
}

func (p *PropertyDataProvider) GetVerification(assetID string) (*PropertyVerification, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	v, ok := p.verifications[assetID]
	return v, ok
}

func (p *PropertyDataProvider) ListVerifications() []*PropertyVerification {
	p.mu.RLock()
	defer p.mu.RUnlock()
	list := make([]*PropertyVerification, 0, len(p.verifications))
	for _, v := range p.verifications {
		list = append(list, v)
	}
	return list
}

// Real integration helpers (for documentation, not called in mock mode)

type BhoomiRequest struct {
	SurveyNumber string `json:"surveyNumber"`
	District     string `json:"district"`
	Taluk        string `json:"taluk"`
	Hobli        string `json:"hobli"`
	Village      string `json:"village"`
}

type BhoomiResponse struct {
	OwnerName   string `json:"ownerName"`
	Extent      string `json:"extent"`
	Valuation   int64  `json:"valuation"`
	Encumbrance bool   `json:"encumbrance"`
}

// In real mode, would call:
// POST https://bhoomi.karnataka.gov.in/api/landrecords with API key
// POST https://dharani.telangana.gov.in/api/encumbrance
// POST https://mahabhulekh.maharashtra.gov.in/api/property
// Or via Setu AA (Account Aggregator) for consent-based access

func (p *PropertyDataProvider) VerifyReal(assetID string, surveyNumber string, source PropertySource) (*PropertyVerification, error) {
	if p.mode != PropertyDataReal {
		return nil, errors.New("real mode not enabled — set PROPERTY_DATA_MODE=real and PROPERTY_DATA_API_KEY")
	}

	apiKey, ok := p.apiKeys[source]
	if !ok || apiKey == "" {
		return nil, fmt.Errorf("no API key for source %s", source)
	}

	// Real implementation would:
	// 1. Call Bhoomi/Dharani API with surveyNumber and apiKey
	// 2. Parse government record
	// 3. Compare with our records
	// 4. Check encumbrance
	// For now, return mock with real mode flag
	_ = apiKey
	return p.Verify(assetID, 7500000, "originator1", "Maharashtra", "Pune", "411045", source)
}
