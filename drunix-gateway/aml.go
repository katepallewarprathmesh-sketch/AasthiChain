package drunix

// Anti money laundering: a list, a match, a case, and a report that exists as
// a file somebody could actually file.
//
// What was here before was screening in name only. Payments were scored for
// fraud, a reporting threshold was applied, and that was called AML. Three
// things were missing, and they are the three things the work actually
// consists of:
//
//   - **A list.** Sanctions and politically exposed person screening is a
//     name-matching problem against a published list, and name matching is
//     hard in exactly the ways that matter: transliteration, word order,
//     missing middle names, honorifics. A system with no list is not
//     screening; it is asserting.
//   - **A case.** A hit is not a decision. Somebody reviews it, writes down
//     what they concluded and why, and either clears it or escalates. An
//     alert with no case file behind it cannot be audited and cannot be
//     defended.
//   - **A report.** The output of an escalation is a suspicious transaction
//     report: a structured document with the subject, the transactions, the
//     grounds for suspicion and the identity of whoever filed it. Until that
//     artefact exists, "we report suspicious activity" is a sentence rather
//     than a capability.
//
// WHAT IS REAL AND WHAT IS NOT
//
// The matching, the case lifecycle and the report artefact are real and are
// exercised by tests. The list shipped with this repository is synthetic: a
// handful of invented names, because publishing a copy of a real sanctions
// list inside a demonstration project invites someone to rely on it, and a
// stale sanctions list is worse than none. A deployment that holds a real
// list points AML_WATCHLIST_PATH at it; the file format is the same and
// nothing else changes. Every surface says which list is loaded.
//
// Nothing here is filed with anybody. A report produced by this code is a
// document on disk and a hash on the ledger, not a submission to the
// Financial Intelligence Unit, and it says so in its own text.

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	BlockAMLHit         = "UMI_AML_HIT"
	BlockAMLCaseOpened  = "UMI_AML_CASE_OPENED"
	BlockAMLCaseCleared = "UMI_AML_CASE_CLEARED"
	BlockAMLReportFiled = "UMI_AML_REPORT_FILED"
	BlockAMLRefused     = "UMI_AML_REFUSED"
)

// Screening decisions. Deliberately three, not two: the interesting state is
// the one where a human has to look.
const (
	AMLClear  = "CLEAR"
	AMLReview = "REVIEW"
	AMLBlock  = "BLOCK"
)

// Case states.
const (
	CaseOpen     = "OPEN"
	CaseInReview = "UNDER_REVIEW"
	CaseCleared  = "CLEARED"
	CaseReported = "REPORTED"
)

// Match strength thresholds. A name that matches a listed name outright, or
// differs by a character, stops the payment. A near match opens a case and
// lets a person decide, because blocking on a 0.85 similarity would stop
// every payment to anybody who shares a surname with a listed person.
const (
	amlBlockScore  = 0.93
	amlReviewScore = 0.80
)

var (
	ErrAMLBlocked     = errors.New("ERR_UMI_AML_BLOCKED")
	ErrAMLNotFound    = errors.New("ERR_UMI_AML_NOT_FOUND")
	ErrAMLState       = errors.New("ERR_UMI_AML_STATE")
	ErrAMLFields      = errors.New("ERR_UMI_AML_FIELDS")
	ErrAMLNotReviewer = errors.New("ERR_UMI_AML_NOT_REVIEWER")
)

// WatchEntry is one listed party. The shape follows what published lists
// carry: a primary name, the spellings it also appears under, why it is
// listed and who listed it.
type WatchEntry struct {
	ListID    string   `json:"listId"`
	Name      string   `json:"name"`
	Aliases   []string `json:"aliases,omitempty"`
	Kind      string   `json:"kind"`      // SANCTION | PEP
	Programme string   `json:"programme"` // the regime or the office held
	Country   string   `json:"country,omitempty"`
	Source    string   `json:"source"` // which list this row came from
	Note      string   `json:"note,omitempty"`
}

// WatchMatch is one listed party a name resembled, with the number that
// decided it. The score is shown rather than hidden: a reviewer who cannot
// see why something matched cannot judge whether it should have.
type WatchMatch struct {
	Entry     WatchEntry `json:"entry"`
	MatchedOn string     `json:"matchedOn"`
	Score     float64    `json:"score"`
	Why       string     `json:"why"`
}

// Screening is the result for one name.
type Screening struct {
	Name       string       `json:"name"`
	Decision   string       `json:"decision"`
	Matches    []WatchMatch `json:"matches"`
	ListName   string       `json:"listName"`
	ListSize   int          `json:"listSize"`
	Synthetic  bool         `json:"listIsSynthetic"`
	ScreenedAt string       `json:"screenedAt"`
	Note       string       `json:"note"`
}

// CaseNote is one line of what somebody concluded, and when.
type CaseNote struct {
	At     string `json:"at"`
	Who    string `json:"who"`
	Action string `json:"action"`
	Text   string `json:"text"`
}

// AMLCase is the file a hit opens. It carries the screening that caused it,
// the payment it relates to, and every step taken since.
type AMLCase struct {
	CaseID       string       `json:"caseId"`
	Subject      string       `json:"subject"`
	Decision     string       `json:"decision"`
	Matches      []WatchMatch `json:"matches"`
	RelatedRef   string       `json:"relatedRef,omitempty"`
	AmountPaise  int64        `json:"amountPaise,omitempty"`
	Counterparty string       `json:"counterparty,omitempty"`
	Status       string       `json:"status"`
	OpenedBy     string       `json:"openedBy"`
	OpenedAt     string       `json:"openedAt"`
	Reviewer     string       `json:"reviewer,omitempty"`
	ClosedAt     string       `json:"closedAt,omitempty"`
	Notes        []CaseNote   `json:"notes"`
	ReportID     string       `json:"reportId,omitempty"`
}

// STReport is the artefact. The field names follow the shape of a suspicious
// transaction report: who, what moved, why it is suspicious, who is saying
// so. It is a document, and its hash goes on the ledger so the version filed
// and the version stored can be shown to be the same one.
type STReport struct {
	ReportID     string       `json:"reportId"`
	CaseID       string       `json:"caseId"`
	FiledBy      string       `json:"filedBy"`
	FiledAt      string       `json:"filedAt"`
	Subject      string       `json:"subject"`
	Counterparty string       `json:"counterparty,omitempty"`
	AmountPaise  int64        `json:"amountPaise,omitempty"`
	RelatedRef   string       `json:"relatedRef,omitempty"`
	Grounds      []string     `json:"grounds"`
	Matches      []WatchMatch `json:"matches"`
	Narrative    string       `json:"narrative"`
	Hash         string       `json:"hash"`
	BlockHeight  int64        `json:"blockHeight"`
	Disclaimer   string       `json:"disclaimer"`
}

const amlDisclaimer = "Simulated AML screening. The list loaded here is synthetic unless this deployment " +
	"configured its own, no report produced here has been filed with the Financial Intelligence Unit or any " +
	"other authority, and nothing in this module is a regulatory determination."

// AMLDesk holds the list, the cases and the reports.
type AMLDesk struct {
	mu        sync.Mutex
	chain     *DrunixChain
	entries   []WatchEntry
	listName  string
	synthetic bool
	cases     map[string]*AMLCase
	order     []string
	reports   map[string]*STReport
}

// NewAMLDesk loads the list. A deployment with its own list sets
// AML_WATCHLIST_PATH; everything else gets the synthetic one committed beside
// this file, and every answer says which it is.
func NewAMLDesk(chain *DrunixChain) *AMLDesk {
	d := &AMLDesk{
		chain:   chain,
		cases:   map[string]*AMLCase{},
		reports: map[string]*STReport{},
	}
	path := strings.TrimSpace(os.Getenv("AML_WATCHLIST_PATH"))
	d.synthetic = path == ""
	raw, path, err := readWatchlist(path)
	if err != nil {
		// A missing list is reported as a missing list. Screening against
		// nothing returns CLEAR for everyone, which must never look like a
		// clean result: the list name says so on every response.
		d.listName = "no list loaded (" + path + " could not be read)"
		return d
	}
	var file struct {
		Name    string       `json:"name"`
		Entries []WatchEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		d.listName = "no list loaded (" + path + " is not valid JSON)"
		return d
	}
	d.entries = file.Entries
	d.listName = file.Name
	if d.listName == "" {
		d.listName = path
	}
	return d
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

var amlHonorifics = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "miss": true, "dr": true, "prof": true,
	"shri": true, "smt": true, "sri": true, "md": true, "mohd": true, "hon": true,
}

// normaliseName lowercases, strips punctuation and honorifics and collapses
// whitespace. "Dr. A. Q. Khan-Hussein" and "a q khan hussein" are the same
// person for matching purposes, and pretending otherwise is how a screen is
// evaded by typing a full stop.
func normaliseName(s string) []string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	out := []string{}
	for _, tok := range strings.Fields(b.String()) {
		if amlHonorifics[tok] {
			continue
		}
		out = append(out, tok)
	}
	return out
}

func levenshtein(a, b string) int {
	if a == b {
		return 0
	}
	if len(a) == 0 {
		return len([]rune(b))
	}
	if len(b) == 0 {
		return len([]rune(a))
	}
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	cur := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		copy(prev, cur)
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

func tokenSimilarity(a, b string) float64 {
	if a == b {
		return 1
	}
	d := levenshtein(a, b)
	longest := len([]rune(a))
	if l := len([]rune(b)); l > longest {
		longest = l
	}
	if longest == 0 {
		return 0
	}
	return 1 - float64(d)/float64(longest)
}

// nameScore compares two names as bags of tokens: every token of the shorter
// name is paired with its best partner in the longer one. This is what makes
// "Rajesh Kumar Verma" match a listed "Rajesh Verma" strongly, and
// "Rajesh Kumar" match it less, which is the behaviour a reviewer expects.
func nameScore(query, listed string) (float64, string) {
	q := normaliseName(query)
	l := normaliseName(listed)
	if len(q) == 0 || len(l) == 0 {
		return 0, ""
	}
	short, long := q, l
	if len(short) > len(long) {
		short, long = long, short
	}
	total := 0.0
	exact := 0
	for _, s := range short {
		best := 0.0
		for _, t := range long {
			if sim := tokenSimilarity(s, t); sim > best {
				best = sim
			}
		}
		if best == 1 {
			exact++
		}
		total += best
	}
	score := total / float64(len(short))
	// A short name matching part of a longer one is a weaker signal than two
	// names of the same length matching: "Kumar" alone should not score as a
	// hit against "Rajesh Kumar Verma".
	coverage := float64(len(short)) / float64(len(long))
	score *= 0.6 + 0.4*coverage

	why := fmt.Sprintf("%d of %d name parts matched exactly; overall similarity %.2f", exact, len(short), score)
	return score, why
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

// Screen matches one name against the loaded list. It takes no lock on
// anything but the list, writes nothing, and is safe to call on the hot path
// of a payment.
// The synthetic list is embedded rather than read from disk. The gateway runs
// from the repository root in development, from its own directory under test
// and from a scratch image in production, where nothing but the binary is
// copied in. A screening layer that silently loads nothing because of a
// working directory is the worst possible failure: it returns CLEAR for
// everybody. A deployment with a real list still overrides it with
// AML_WATCHLIST_PATH, which is read from disk as normal.
//
//go:embed data/watchlist.json
var syntheticWatchlist []byte

func readWatchlist(configured string) ([]byte, string, error) {
	if configured != "" {
		raw, err := os.ReadFile(configured)
		return raw, configured, err
	}
	return syntheticWatchlist, "data/watchlist.json (embedded)", nil
}

func (d *AMLDesk) Screen(name string) Screening {
	d.mu.Lock()
	entries := d.entries
	listName, synthetic := d.listName, d.synthetic
	d.mu.Unlock()

	s := Screening{
		Name: name, Decision: AMLClear, Matches: []WatchMatch{},
		ListName: listName, ListSize: len(entries), Synthetic: synthetic,
		ScreenedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if strings.TrimSpace(name) == "" {
		s.Note = "No name was given to screen. An unnamed party is not a cleared party."
		return s
	}
	if len(entries) == 0 {
		s.Note = "No list is loaded on this deployment, so this is not a screening result. " +
			"Set AML_WATCHLIST_PATH to screen against a real list."
		return s
	}

	for _, e := range entries {
		best, why := nameScore(name, e.Name)
		matchedOn := e.Name
		for _, alias := range e.Aliases {
			if sc, w := nameScore(name, alias); sc > best {
				best, why, matchedOn = sc, w, alias
			}
		}
		if best >= amlReviewScore {
			s.Matches = append(s.Matches, WatchMatch{Entry: e, MatchedOn: matchedOn, Score: amlRound2(best), Why: why})
		}
	}
	sort.Slice(s.Matches, func(i, j int) bool { return s.Matches[i].Score > s.Matches[j].Score })
	if len(s.Matches) > 5 {
		s.Matches = s.Matches[:5]
	}

	switch {
	case len(s.Matches) == 0:
		s.Note = fmt.Sprintf("No name on %s resembled this one closely enough to look at.", listName)
	case s.Matches[0].Score >= amlBlockScore:
		s.Decision = AMLBlock
		s.Note = fmt.Sprintf("This name matches %q on %s (%s). The payment does not proceed; a case is opened for review.",
			s.Matches[0].Entry.Name, listName, s.Matches[0].Entry.Programme)
	default:
		s.Decision = AMLReview
		s.Note = fmt.Sprintf("This name resembles %q on %s but is not the same string. A person decides, not this code.",
			s.Matches[0].Entry.Name, listName)
	}
	return s
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

// OpenCase files a hit. Called by the payment path on a block or a review,
// and callable directly by a compliance user who wants to record something
// the automation did not catch.
func (d *AMLDesk) OpenCase(s Screening, openedBy, relatedRef, counterparty string, amountPaise int64) *AMLCase {
	d.mu.Lock()
	defer d.mu.Unlock()

	c := &AMLCase{
		CaseID: cbdcID("AML-CASE"), Subject: s.Name, Decision: s.Decision, Matches: s.Matches,
		RelatedRef: relatedRef, Counterparty: counterparty, AmountPaise: amountPaise,
		Status: CaseOpen, OpenedBy: openedBy, OpenedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Notes: []CaseNote{{
			At: time.Now().UTC().Format(time.RFC3339Nano), Who: openedBy, Action: "OPENED", Text: s.Note,
		}},
	}
	d.cases[c.CaseID] = c
	d.order = append(d.order, c.CaseID)

	block := BlockAMLCaseOpened
	if s.Decision == AMLBlock {
		block = BlockAMLRefused
	}
	d.commit(block, map[string]interface{}{
		"caseId": c.CaseID, "subject": c.Subject, "decision": c.Decision,
		"relatedRef": relatedRef, "listName": s.ListName, "listIsSynthetic": s.Synthetic,
		"topMatch": topMatchName(s), "note": c.Notes[0].Text,
	})
	return c
}

func topMatchName(s Screening) string {
	if len(s.Matches) == 0 {
		return ""
	}
	return s.Matches[0].Entry.Name
}

func amlRound2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}

// Review records that somebody picked the case up. The reviewer is named
// because an unattributed clearance is not a control.
func (d *AMLDesk) Review(caseID, who, text string) (*AMLCase, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.cases[caseID]
	if !ok {
		return nil, fmt.Errorf("%w: no case with that reference", ErrAMLNotFound)
	}
	if c.Status == CaseCleared || c.Status == CaseReported {
		return nil, fmt.Errorf("%w: this case is already %s", ErrAMLState, strings.ToLower(c.Status))
	}
	c.Status = CaseInReview
	c.Reviewer = who
	c.Notes = append(c.Notes, CaseNote{At: time.Now().UTC().Format(time.RFC3339Nano), Who: who, Action: "REVIEWING", Text: text})
	return c, nil
}

// Clear closes a case as a false positive. It demands a reason: "cleared" with
// no grounds recorded is the thing an audit finds and cannot explain.
func (d *AMLDesk) Clear(caseID, who, reason string) (*AMLCase, error) {
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("%w: clearing a case requires the grounds for clearing it", ErrAMLFields)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.cases[caseID]
	if !ok {
		return nil, fmt.Errorf("%w: no case with that reference", ErrAMLNotFound)
	}
	if c.Status == CaseReported {
		return nil, fmt.Errorf("%w: a reported case cannot be cleared afterwards", ErrAMLState)
	}
	if c.Status == CaseCleared {
		return nil, fmt.Errorf("%w: this case is already cleared", ErrAMLState)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	c.Status = CaseCleared
	c.Reviewer = who
	c.ClosedAt = now
	c.Notes = append(c.Notes, CaseNote{At: now, Who: who, Action: "CLEARED", Text: reason})
	d.commit(BlockAMLCaseCleared, map[string]interface{}{
		"caseId": c.CaseID, "subject": c.Subject, "clearedBy": who, "grounds": reason,
	})
	return c, nil
}

// Report escalates a case into a suspicious transaction report. The artefact
// is built here, hashed, and the hash committed: the document and the ledger
// entry can be checked against each other afterwards by anybody holding the
// file.
func (d *AMLDesk) Report(caseID, who string, grounds []string, narrative string) (*AMLCase, *STReport, error) {
	clean := []string{}
	for _, g := range grounds {
		if strings.TrimSpace(g) != "" {
			clean = append(clean, strings.TrimSpace(g))
		}
	}
	if len(clean) == 0 {
		return nil, nil, fmt.Errorf("%w: a report needs at least one stated ground for suspicion", ErrAMLFields)
	}
	if strings.TrimSpace(narrative) == "" {
		return nil, nil, fmt.Errorf("%w: a report needs a narrative describing what was observed", ErrAMLFields)
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.cases[caseID]
	if !ok {
		return nil, nil, fmt.Errorf("%w: no case with that reference", ErrAMLNotFound)
	}
	if c.Status == CaseCleared {
		return nil, nil, fmt.Errorf("%w: this case was cleared; reopen the question with a new case rather than reporting a closed one", ErrAMLState)
	}
	if c.Status == CaseReported {
		return nil, nil, fmt.Errorf("%w: a report has already been produced for this case (%s)", ErrAMLState, c.ReportID)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	r := &STReport{
		ReportID: cbdcID("AML-STR"), CaseID: c.CaseID, FiledBy: who, FiledAt: now,
		Subject: c.Subject, Counterparty: c.Counterparty, AmountPaise: c.AmountPaise,
		RelatedRef: c.RelatedRef, Grounds: clean, Matches: c.Matches,
		Narrative: strings.TrimSpace(narrative),
		Disclaimer: "This document has not been filed with the Financial Intelligence Unit or any other " +
			"authority. It is produced by a simulation to show the artefact that escalation yields.",
	}
	// The hash covers the report with the hash field empty, so anybody
	// holding the document can recompute it the same way.
	body, _ := json.Marshal(*r)
	sum := sha256.Sum256(body)
	r.Hash = hex.EncodeToString(sum[:])

	blk := d.commit(BlockAMLReportFiled, map[string]interface{}{
		"reportId": r.ReportID, "caseId": c.CaseID, "subject": c.Subject,
		"filedBy": who, "hash": r.Hash, "grounds": clean,
		"note": "Hash only. The report itself is held off the chain and can be checked against this hash.",
	})
	if blk != nil {
		r.BlockHeight = blk.Height
	}

	d.reports[r.ReportID] = r
	c.Status = CaseReported
	c.ReportID = r.ReportID
	c.Reviewer = who
	c.ClosedAt = now
	c.Notes = append(c.Notes, CaseNote{At: now, Who: who, Action: "REPORTED", Text: strings.Join(clean, "; ")})
	return c, r, nil
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

func (d *AMLDesk) Cases(limit int) []AMLCase {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []AMLCase{}
	for i := len(d.order) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		if c, ok := d.cases[d.order[i]]; ok {
			out = append(out, *c)
		}
	}
	return out
}

func (d *AMLDesk) Case(id string) (*AMLCase, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.cases[id]
	if !ok {
		return nil, fmt.Errorf("%w: no case with that reference", ErrAMLNotFound)
	}
	cp := *c
	return &cp, nil
}

func (d *AMLDesk) ReportByID(id string) (*STReport, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r, ok := d.reports[id]
	if !ok {
		return nil, fmt.Errorf("%w: no report with that reference", ErrAMLNotFound)
	}
	cp := *r
	return &cp, nil
}

// Watchlist is public on purpose. A person refused by a screen is entitled to
// know what they were screened against, and a list nobody can see cannot be
// corrected.
func (d *AMLDesk) Watchlist() []WatchEntry {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]WatchEntry, len(d.entries))
	copy(out, d.entries)
	return out
}

func (d *AMLDesk) Status() map[string]interface{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	counts := map[string]int{CaseOpen: 0, CaseInReview: 0, CaseCleared: 0, CaseReported: 0}
	for _, c := range d.cases {
		counts[c.Status]++
	}
	sanctions, peps := 0, 0
	for _, e := range d.entries {
		if strings.EqualFold(e.Kind, "PEP") {
			peps++
		} else {
			sanctions++
		}
	}
	return map[string]interface{}{
		"listName":        d.listName,
		"listIsSynthetic": d.synthetic,
		"listSize":        len(d.entries),
		"sanctionEntries": sanctions,
		"pepEntries":      peps,
		"cases":           counts,
		"reports":         len(d.reports),
		"thresholds": map[string]interface{}{
			"block":  amlBlockScore,
			"review": amlReviewScore,
			"meaning": "At or above the block score the payment stops and a case opens. Between the two a " +
				"case opens and the payment continues, because a near match is a question rather than an answer.",
		},
		"disclaimer": amlDisclaimer,
	}
}

func (d *AMLDesk) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if d.chain == nil {
		return nil
	}
	txn["rail"] = "AML screening (simulated)"
	return d.chain.Append(blockType, []map[string]interface{}{txn})
}

// ScreenParties is what the payment path calls: both ends of a transfer in
// one go, with the worst decision winning. It returns the screening that
// decided it so the caller can name the list and the match in its refusal.
func (d *AMLDesk) ScreenParties(names ...string) Screening {
	worst := Screening{Decision: AMLClear}
	first := true
	for _, n := range names {
		if strings.TrimSpace(n) == "" {
			continue
		}
		s := d.Screen(n)
		if first || amlRank(s.Decision) > amlRank(worst.Decision) {
			worst = s
			first = false
		}
	}
	if first {
		return Screening{Decision: AMLClear, Note: "No party names were supplied to screen.", Matches: []WatchMatch{}}
	}
	return worst
}

func amlRank(decision string) int {
	switch decision {
	case AMLBlock:
		return 2
	case AMLReview:
		return 1
	default:
		return 0
	}
}

// AMLListDescription is what the gateway logs at start-up, so an operator can
// see from the first line of output whether real screening is in force.
func AMLListDescription(d *AMLDesk) string {
	if d == nil {
		return "not mounted"
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	kind := "a configured list"
	if d.synthetic {
		kind = "the synthetic list shipped with this repository, which designates nobody"
	}
	return fmt.Sprintf("%d entries from %s (%s)", len(d.entries), d.listName, kind)
}
