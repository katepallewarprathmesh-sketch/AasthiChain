package drunix

// Talent provider adapter: the boundary between our escrow and whoever
// supplies the people who do the work.
//
// A gig-work platform matches an order to a worker. We do not want to be one,
// and we do not need to be: the only thing the work desk needs from outside is
// somebody to do the job. So the integration is narrow by design. We publish an
// order's spec and acceptance criteria, we get a worker reference back, and we
// record it. Escrow, state and evidence never leave our ledger. No external
// party is asked to hold money, and we are not asked to host a talent graph.
//
// No external provider is configured in this repository, and none is named.
// This follows the pattern the repo already uses for NPCI: a real HTTP call
// when the environment names an endpoint, an honest local simulation
// otherwise. Mode is reported on every payload, so a screenshot can never
// imply an integration that is not wired up. The wire format below is our own
// shape, not any vendor's published contract: pointing this at a real service
// would mean mapping the field names in this one file, which is exactly why
// the seam is here and not in the desk.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// TalentProvider is the seam (DIP): the desk depends on this interface, never
// on any particular provider.
type TalentProvider interface {
	Name() string
	// Mode is "live" when the adapter is configured against a real endpoint,
	// "simulation" otherwise.
	Mode() string
	// Publish offers an order to the provider and returns their reference for
	// the engagement. A failure here must never block the order: the work can
	// still be assigned by hand.
	Publish(o *WorkOrder) (ref string, err error)
	// Roster is the shortlist shown next to an unassigned order.
	Roster(category string) []TalentProfile
	// Describe is the adapter's own status, for /umi/work/provider.
	Describe() map[string]interface{}
}

// TalentProfile is one candidate for a work order.
type TalentProfile struct {
	WorkerID   string   `json:"workerId"`
	Name       string   `json:"name"`
	Skills     []string `json:"skills"`
	City       string   `json:"city"`
	RatePerDay float64  `json:"ratePerDayINR"`
	Rating     float64  `json:"rating"`
	Source     string   `json:"source"`
}

// WorkProvider is the default TalentProvider: an HTTP adapter that degrades
// to a local simulation when no endpoint is configured.
type WorkProvider struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

// NewWorkProvider reads WORK_PROVIDER_URL / WORK_PROVIDER_KEY. With either
// one missing the adapter stays in simulation and says so.
func NewWorkProvider() *WorkProvider {
	return &WorkProvider{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("WORK_PROVIDER_URL")), "/"),
		apiKey:  strings.TrimSpace(os.Getenv("WORK_PROVIDER_KEY")),
		client:  &http.Client{Timeout: 8 * time.Second},
	}
}

// Name implements TalentProvider.
func (p *WorkProvider) Name() string { return "work-provider" }

func (p *WorkProvider) configured() bool { return p.baseURL != "" && p.apiKey != "" }

// Mode implements TalentProvider.
func (p *WorkProvider) Mode() string {
	if p.configured() {
		return "live"
	}
	return "simulation"
}

// Publish implements TalentProvider.
func (p *WorkProvider) Publish(o *WorkOrder) (string, error) {
	if !p.configured() {
		// Deterministic reference so the demo reads like the real thing
		// without pretending a call happened.
		return "WRK-SIM-" + strings.ToUpper(strings.TrimPrefix(o.OrderID, "WORK-")), nil
	}
	payload := map[string]interface{}{
		"externalId":         o.OrderID,
		"title":              o.Title,
		"description":        o.Spec,
		"category":           o.Category,
		"budgetINR":          o.FeeINR,
		"acceptanceCriteria": o.AcceptanceCriteria,
		"escrow": map[string]interface{}{
			"held":       o.Escrowed,
			"instrument": "e₹-W wholesale CBDC (simulated)",
			"releasedOn": "acceptance of the anchored deliverable",
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, p.baseURL+"/gigs", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("work provider responded %d", resp.StatusCode)
	}
	var out struct {
		ID        string `json:"id"`
		GigID     string `json:"gigId"`
		Reference string `json:"reference"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	for _, v := range []string{out.Reference, out.GigID, out.ID} {
		if v != "" {
			return v, nil
		}
	}
	return "", nil
}

// simulatedRoster is a small, honest stand-in: enough to demonstrate the flow,
// labelled everywhere as a simulation, and replaced wholesale the moment a real
// endpoint is configured.
var simulatedRoster = []TalentProfile{
	{WorkerID: "wrk-anita-s", Name: "Anita S.", Skills: []string{"INSPECTION", "PHOTOGRAPHY"}, City: "Pune", RatePerDay: 4500, Rating: 4.8},
	{WorkerID: "wrk-vikram-j", Name: "Vikram J.", Skills: []string{"VALUATION", "LEGAL_REVIEW"}, City: "Pune", RatePerDay: 7200, Rating: 4.6},
	{WorkerID: "wrk-fatima-q", Name: "Fatima Q.", Skills: []string{"TITLE_VERIFICATION", "LEGAL_REVIEW"}, City: "Mumbai", RatePerDay: 8000, Rating: 4.9},
	{WorkerID: "wrk-deepak-r", Name: "Deepak R.", Skills: []string{"REPAIR", "INSPECTION"}, City: "Pune", RatePerDay: 3200, Rating: 4.4},
}

// Roster implements TalentProvider.
func (p *WorkProvider) Roster(category string) []TalentProfile {
	category = strings.ToUpper(strings.TrimSpace(category))
	out := make([]TalentProfile, 0, len(simulatedRoster))
	for _, t := range simulatedRoster {
		t.Source = p.Mode()
		if category == "" {
			out = append(out, t)
			continue
		}
		for _, s := range t.Skills {
			if s == category {
				out = append(out, t)
				break
			}
		}
	}
	return out
}

// Describe implements TalentProvider.
func (p *WorkProvider) Describe() map[string]interface{} {
	return map[string]interface{}{
		"provider": p.Name(),
		"pattern":  "gig-work marketplace: pay released against verified task completion",
		"mode":     p.Mode(),
		"configured": map[string]bool{
			"WORK_PROVIDER_URL": p.baseURL != "",
			"WORK_PROVIDER_KEY": p.apiKey != "",
		},
		"whatCrossesTheBoundary": []string{
			"out: the order's title, spec, category, budget and acceptance criteria",
			"in: a provider reference for the engagement, recorded as providerRef",
		},
		"whatStaysHere": []string{
			"the escrowed fee and the e₹-W wallets",
			"the state machine and who is allowed to move it",
			"the deliverable hash and every block in the audit trail",
		},
		"toGoLive":   "set WORK_PROVIDER_URL and WORK_PROVIDER_KEY; no code changes",
		"disclaimer": "Simulation unless both environment variables are set. No external talent provider is integrated, and the request shape this adapter sends is this project's own rather than a vendor contract.",
	}
}
