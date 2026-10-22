package drunix

import (
	"strings"
	"testing"
)

func newAMLTestDesk(t *testing.T) *AMLDesk {
	t.Helper()
	d := NewAMLDesk(NewChain())
	if len(d.entries) == 0 {
		t.Fatalf("the synthetic list did not load: %s", d.listName)
	}
	return d
}

func TestAMLMatchesTheObviousAndTheAwkward(t *testing.T) {
	d := newAMLTestDesk(t)

	cases := []struct {
		name string
		want string
	}{
		// The easy one: the listed string itself.
		{"Dmitri Volkanov", AMLBlock},
		// Honorifics and punctuation must not defeat a screen.
		{"Mr. Dmitri Volkanov", AMLBlock},
		// A different transliteration is listed as an alias.
		{"Dimitri Volkanoff", AMLBlock},
		// A dropped middle name is a question, not a certainty.
		{"Ana Ferreira", AMLReview},
		// A common surname alone must not stop a payment.
		{"Kumar", AMLClear},
		// Somebody entirely unrelated.
		{"Priya Shankar", AMLClear},
	}
	for _, c := range cases {
		got := d.Screen(c.name)
		if got.Decision != c.want {
			t.Errorf("%q: decision %s, want %s (top match %q score %.2f)",
				c.name, got.Decision, c.want, topMatchName(got), topScore(got))
		}
	}
}

func topScore(s Screening) float64 {
	if len(s.Matches) == 0 {
		return 0
	}
	return s.Matches[0].Score
}

func TestAMLScreeningExplainsItself(t *testing.T) {
	d := newAMLTestDesk(t)
	s := d.Screen("Dmitri Volkanov")
	if len(s.Matches) == 0 {
		t.Fatal("a blocking decision with no match recorded cannot be reviewed")
	}
	if s.Matches[0].Why == "" || s.Matches[0].Score <= 0 {
		t.Errorf("the match carries no score or reason: %+v", s.Matches[0])
	}
	if !s.Synthetic {
		t.Error("the shipped list must declare itself synthetic")
	}
	if !strings.Contains(strings.ToLower(s.Note), "case") {
		t.Errorf("a block should say what happens next, got %q", s.Note)
	}
}

func TestAMLCaseLifecycle(t *testing.T) {
	d := newAMLTestDesk(t)
	c := d.OpenCase(d.Screen("Dmitri Volkanov"), "regulator1", "CBX-TEST", "originator1", 500000)
	if c.Status != CaseOpen {
		t.Fatalf("a new case starts open, got %s", c.Status)
	}

	if _, err := d.Clear(c.CaseID, "regulator1", ""); err == nil {
		t.Error("clearing with no grounds must be refused")
	}
	if _, err := d.Review(c.CaseID, "regulator1", "looking at it"); err != nil {
		t.Fatalf("review: %v", err)
	}
	got, err := d.Clear(c.CaseID, "regulator1", "Same name, different date of birth and passport.")
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got.Status != CaseCleared || got.ClosedAt == "" || got.Reviewer != "regulator1" {
		t.Errorf("a cleared case must name its reviewer and when: %+v", got)
	}
	if len(got.Notes) != 3 {
		t.Errorf("every step is recorded; got %d notes", len(got.Notes))
	}
	if _, err := d.Clear(c.CaseID, "regulator1", "again"); err == nil {
		t.Error("a cleared case cannot be cleared twice")
	}
	if _, _, err := d.Report(c.CaseID, "regulator1", []string{"x"}, "y"); err == nil {
		t.Error("a cleared case must not be reportable without reopening the question")
	}
}

func TestAMLReportIsADocumentWithAHashOnTheLedger(t *testing.T) {
	chain := NewChain()
	d := NewAMLDesk(chain)
	c := d.OpenCase(d.Screen("Arvex Metals Trading FZE"), "regulator1", "CBX-9", "investor1", 2500000)

	if _, _, err := d.Report(c.CaseID, "regulator1", nil, "narrative"); err == nil {
		t.Error("a report with no stated grounds must be refused")
	}
	if _, _, err := d.Report(c.CaseID, "regulator1", []string{"sanctions match"}, ""); err == nil {
		t.Error("a report with no narrative must be refused")
	}

	updated, r, err := d.Report(c.CaseID, "regulator1",
		[]string{"Name matches a listed entity", "Purpose inconsistent with stated business"},
		"Payment to an entity whose name matches a listed party, with no supporting documentation.")
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if updated.Status != CaseReported || updated.ReportID != r.ReportID {
		t.Errorf("the case must point at its report: %+v", updated)
	}
	if len(r.Hash) != 64 {
		t.Errorf("the report must be hashed, got %q", r.Hash)
	}
	if r.BlockHeight == 0 {
		t.Error("the hash must be committed to the chain")
	}
	if !strings.Contains(r.Disclaimer, "not been filed") {
		t.Errorf("the artefact must say it was not filed with anybody: %q", r.Disclaimer)
	}
	if _, _, err := d.Report(c.CaseID, "regulator1", []string{"again"}, "again"); err == nil {
		t.Error("a case cannot be reported twice")
	}

	// The block carries the hash and nothing suspicious in clear text beyond
	// the subject, which the case already holds.
	found := false
	for _, b := range chain.Snapshot() {
		if b.Type == BlockAMLReportFiled {
			found = true
		}
	}
	if !found {
		t.Error("filing a report must write a block")
	}
}

func TestAMLWorstDecisionWins(t *testing.T) {
	d := newAMLTestDesk(t)
	s := d.ScreenParties("Priya Shankar", "Dmitri Volkanov")
	if s.Decision != AMLBlock {
		t.Errorf("screening two parties takes the worse answer, got %s", s.Decision)
	}
	empty := d.ScreenParties("", "")
	if empty.Decision != AMLClear || !strings.Contains(empty.Note, "No party names") {
		t.Errorf("no names is reported as no names, got %+v", empty)
	}
}

func TestAMLStatusDeclaresTheList(t *testing.T) {
	d := newAMLTestDesk(t)
	st := d.Status()
	if st["listIsSynthetic"] != true {
		t.Error("the status must declare the shipped list synthetic")
	}
	if st["listSize"].(int) < 5 {
		t.Errorf("the list looks empty: %v", st["listSize"])
	}
	if !strings.Contains(st["disclaimer"].(string), "has been filed with the Financial Intelligence Unit") {
		t.Errorf("the disclaimer must say nothing is filed: %v", st["disclaimer"])
	}
}
