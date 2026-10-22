package drunix

// Electronic KYC: the verification flow, including the part where this system
// refuses to hold what it is not allowed to hold.
//
// Until now a wallet's KYC tier was a string somebody passed in. The holder
// was MIN_KYC or FULL_KYC because the request said so, which means the caps
// built on top of it were decoration. This layer makes the tier the output of
// a verification with a route, evidence, an expiry and an audit trail, rather
// than an input somebody asserts.
//
// WHAT THE RULES ACTUALLY SAY, AND WHERE THEY COME FROM
//
// The Reserve Bank repealed the consolidated 2016 Master Direction on KYC on
// 28 November 2025 and replaced it with Directions for each type of regulated
// entity. The shape below follows the published position as at that
// replacement:
//
//   - **Four identification routes inside a video session**, and the same
//     four as standalone routes: OTP-based Aadhaar e-KYC, offline
//     verification of Aadhaar, a record downloaded from the Central KYC
//     Records Registry against a KYC Identifier, and an equivalent
//     e-document of an officially valid document including one from
//     DigiLocker.
//   - **The video process (V-CIP) is treated on par with face-to-face.** A
//     customer identified that way carries no annual debit ceiling and no
//     enhanced due diligence classification purely for being remote.
//   - **OTP-based Aadhaar e-KYC alone is non-face-to-face**, and carries a
//     one lakh rupee cumulative annual debit limit plus enhanced due
//     diligence until it is converted, typically through a video session.
//   - **Offline Aadhaar XML has a freshness condition**: the file or QR code
//     must be generated no more than three working days before the session
//     that relies on it.
//   - **The KYC record goes to the registry within ten days** of starting the
//     relationship, and the KYC Identifier is given back to the customer so
//     the next institution can fetch it instead of asking again.
//   - **Periodic updation**: two years for high risk, eight for medium, ten
//     for low.
//
// THE RULE THAT CHANGES THE DATA MODEL
//
// The Aadhaar number must not be stored. Section 8A(4) of the Aadhaar Act
// bars an offline verification entity from even collecting it; an
// authentication user agency that does hold one must keep it in a separate
// encrypted vault and use a reference key everywhere else, and no more than
// the last four digits may be displayed.
//
// This project is not a licensed user agency and operates no vault. So the
// honest implementation is not "store it carefully": it is to refuse the
// number outright. Submit a twelve-digit Aadhaar number here and the request
// is rejected, with the reason. What is accepted instead is what the offline
// route actually produces: a reference identifier carrying the last four
// digits and a timestamp, with no number behind it.
//
// WHAT IS SIMULATED
//
// Everything that requires an external party is simulated and says so: there
// is no UIDAI authentication call, no CKYCR upload, no live video session, no
// face match and no liveness check. What is real is the flow around them: the
// routes and what each one permits, the refusals, the caps that follow from
// the route, the expiry, and the fact that a wallet's tier can now only be
// raised by a verification that happened.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	BlockKYCSubmitted = "UMI_KYC_SUBMITTED"
	BlockKYCVerified  = "UMI_KYC_VERIFIED"
	BlockKYCRefused   = "UMI_KYC_REFUSED"
	BlockKYCExpired   = "UMI_KYC_EXPIRED"
)

// The identification routes, as the Directions list them.
const (
	RouteAadhaarOTP     = "AADHAAR_OTP_EKYC"
	RouteAadhaarOffline = "AADHAAR_OFFLINE_XML"
	RouteCKYCIdentifier = "CKYC_IDENTIFIER"
	RouteDigiLockerOVD  = "DIGILOCKER_OVD"
	RouteVideoCIP       = "VCIP"
)

// Risk bands, which set when the record has to be refreshed.
const (
	RiskLow    = "LOW"
	RiskMedium = "MEDIUM"
	RiskHigh   = "HIGH"
)

const (
	// One lakh rupees: the cumulative annual debit ceiling that applies to a
	// customer identified by OTP-based Aadhaar e-KYC alone.
	otpAnnualDebitCapPaise = int64(10000000)
	// Three working days, the freshness condition on an offline Aadhaar file.
	offlineXMLFreshness = 72 * time.Hour
	// Ten days to put the record on the registry.
	ckycUploadWindow = 10 * 24 * time.Hour
)

var (
	ErrKYCFields    = errors.New("ERR_UMI_KYC_FIELDS")
	ErrKYCAadhaar   = errors.New("ERR_UMI_KYC_AADHAAR_NOT_ACCEPTED")
	ErrKYCRoute     = errors.New("ERR_UMI_KYC_ROUTE")
	ErrKYCStale     = errors.New("ERR_UMI_KYC_STALE_EVIDENCE")
	ErrKYCNotFound  = errors.New("ERR_UMI_KYC_NOT_FOUND")
	ErrKYCNoConsent = errors.New("ERR_UMI_KYC_NO_CONSENT")
)

var (
	panRe        = regexp.MustCompile(`^[A-Z]{5}[0-9]{4}[A-Z]$`)
	twelveDigits = regexp.MustCompile(`\b\d{12}\b`)
	// What the offline route actually returns: last four digits then a
	// timestamp. No Aadhaar number is present in it, which is the point.
	offlineRefRe = regexp.MustCompile(`^\d{4}[0-9]{8,16}$`)
)

const kycDisclaimer = "Simulated verification. There is no UIDAI authentication call, no upload to the Central " +
	"KYC Records Registry, no live video session and no face match here: this deployment is not a licensed user " +
	"agency and operates no Aadhaar data vault. What is real is the flow: the routes, what each one permits, the " +
	"refusals, the resulting caps, and the fact that a wallet tier can no longer be asserted without one."

// KYCRecord is one completed verification.
type KYCRecord struct {
	KYCID    string `json:"kycId"`
	Holder   string `json:"holder"`
	Route    string `json:"route"`
	RiskBand string `json:"riskBand"`

	// FaceToFaceEquivalent decides the ceilings. It is a property of the
	// route, not of how confident anybody feels.
	FaceToFaceEquivalent bool   `json:"faceToFaceEquivalent"`
	Tier                 string `json:"tier"`
	AnnualDebitCapPaise  int64  `json:"annualDebitCapPaise,omitempty"`
	EnhancedDueDiligence bool   `json:"enhancedDueDiligence"`

	// Evidence, in the only form this system is allowed to keep.
	EvidenceKind string `json:"evidenceKind"`
	EvidenceHash string `json:"evidenceHash"`
	AadhaarLast4 string `json:"aadhaarLast4,omitempty"`
	PANLast4     string `json:"panLast4,omitempty"`

	KYCIdentifier  string `json:"kycIdentifier"`
	VerifiedAt     string `json:"verifiedAt"`
	ExpiresAt      string `json:"expiresAt"`
	RegistryDueBy  string `json:"registryUploadDueBy"`
	RegistryStatus string `json:"registryStatus"`
	VerifiedBy     string `json:"verifiedBy"`
	Simulated      bool   `json:"simulated"`
	Note           string `json:"note"`
}

// KYCRequest is what a caller submits. There is deliberately no field for an
// Aadhaar number, and one that arrives anyway is rejected rather than ignored.
type KYCRequest struct {
	Holder           string `json:"holder"`
	Route            string `json:"route"`
	RiskBand         string `json:"riskBand"`
	Consent          bool   `json:"consent"`
	PAN              string `json:"pan"`
	OfflineRef       string `json:"offlineReferenceId"`
	OfflineGenerated string `json:"offlineGeneratedAt"`
	KYCIdentifier    string `json:"kycIdentifier"`
	DocumentRef      string `json:"documentReference"`
	VideoOfficial    string `json:"videoOfficial"`
	LivenessPassed   bool   `json:"livenessPassed"`
	PANShownOnCall   bool   `json:"panShownOnCall"`
	LocationInIndia  bool   `json:"locationInIndia"`
}

// KYCDesk holds the records.
type KYCDesk struct {
	mu      sync.Mutex
	chain   *DrunixChain
	cbdc    *CBDCLedger
	records map[string]*KYCRecord // by holder: the current record
	order   []string
	history []KYCRecord
}

func NewKYCDesk(chain *DrunixChain, cbdc *CBDCLedger) *KYCDesk {
	return &KYCDesk{chain: chain, cbdc: cbdc, records: map[string]*KYCRecord{}}
}

// Verify runs the flow. It returns a record on success and a refusal that
// names the rule on failure, because "KYC failed" teaches the customer
// nothing and the operator less.
func (k *KYCDesk) Verify(req KYCRequest, by string, now time.Time) (*KYCRecord, error) {
	holder := strings.TrimSpace(req.Holder)
	if holder == "" {
		return nil, fmt.Errorf("%w: a verification is about somebody", ErrKYCFields)
	}
	route := strings.ToUpper(strings.TrimSpace(req.Route))

	// Before anything else: refuse an Aadhaar number wherever it appears.
	// Collecting it is what this deployment is not permitted to do, and
	// quietly dropping it would hide the rule instead of enforcing it.
	for field, v := range map[string]string{
		"offlineReferenceId": req.OfflineRef, "kycIdentifier": req.KYCIdentifier,
		"documentReference": req.DocumentRef, "pan": req.PAN,
	} {
		if twelveDigits.MatchString(strings.ReplaceAll(v, " ", "")) {
			k.refuse(holder, route, "AADHAAR_NUMBER_SUBMITTED",
				"A twelve digit number that looks like an Aadhaar number was submitted in "+field+".")
			return nil, fmt.Errorf("%w: %s looks like an Aadhaar number. This system does not accept, store or "+
				"transmit Aadhaar numbers: it is not a licensed user agency and operates no Aadhaar data vault. "+
				"Use the offline reference identifier, which carries only the last four digits", ErrKYCAadhaar, field)
		}
	}

	if !req.Consent {
		k.refuse(holder, route, "NO_CONSENT", "The holder did not record consent.")
		return nil, fmt.Errorf("%w: identification requires the holder's recorded consent, and it is voluntary: "+
			"nobody may be refused service for declining to use an Aadhaar route", ErrKYCNoConsent)
	}

	band := strings.ToUpper(strings.TrimSpace(req.RiskBand))
	if band == "" {
		band = RiskMedium
	}
	if band != RiskLow && band != RiskMedium && band != RiskHigh {
		return nil, fmt.Errorf("%w: risk band is LOW, MEDIUM or HIGH", ErrKYCFields)
	}

	rec := &KYCRecord{
		Holder: holder, Route: route, RiskBand: band, VerifiedBy: by, Simulated: true,
	}

	switch route {
	case RouteAadhaarOTP:
		// Non-face-to-face. Permitted, and limited for exactly that reason.
		if !offlineRefRe.MatchString(strings.TrimSpace(req.OfflineRef)) {
			return nil, fmt.Errorf("%w: this route records the reference identifier UIDAI returns "+
				"(last four digits followed by a timestamp), never the Aadhaar number", ErrKYCFields)
		}
		rec.FaceToFaceEquivalent = false
		rec.Tier = KYCMinimal
		rec.AnnualDebitCapPaise = otpAnnualDebitCapPaise
		rec.EnhancedDueDiligence = true
		rec.EvidenceKind = "UIDAI reference identifier (simulated authentication)"
		rec.AadhaarLast4 = strings.TrimSpace(req.OfflineRef)[:4]
		rec.EvidenceHash = hashEvidence(req.OfflineRef)
		rec.Note = "Identified without meeting anybody: a one lakh rupee cumulative annual debit ceiling and " +
			"enhanced due diligence apply until this is converted through a video session."

	case RouteAadhaarOffline:
		ref := strings.TrimSpace(req.OfflineRef)
		if !offlineRefRe.MatchString(ref) {
			return nil, fmt.Errorf("%w: the offline route produces a reference identifier of the last four "+
				"digits and a timestamp; that is what this expects", ErrKYCFields)
		}
		gen, err := time.Parse(time.RFC3339, strings.TrimSpace(req.OfflineGenerated))
		if err != nil {
			return nil, fmt.Errorf("%w: when the offline file was generated is required, because it expires", ErrKYCFields)
		}
		if now.Sub(gen) > offlineXMLFreshness {
			k.refuse(holder, route, "STALE_OFFLINE_FILE",
				fmt.Sprintf("The offline file was generated %d hours ago.", int(now.Sub(gen).Hours())))
			return nil, fmt.Errorf("%w: an offline Aadhaar file must be no more than three working days old, "+
				"and this one was generated %d hours ago", ErrKYCStale, int(now.Sub(gen).Hours()))
		}
		rec.FaceToFaceEquivalent = false
		rec.Tier = KYCMinimal
		rec.AnnualDebitCapPaise = otpAnnualDebitCapPaise
		rec.EnhancedDueDiligence = false
		rec.EvidenceKind = "Offline Aadhaar reference identifier, signature check simulated"
		rec.AadhaarLast4 = ref[:4]
		rec.EvidenceHash = hashEvidence(ref)
		rec.Note = "The offline file carries no Aadhaar number, only a reference identifier, which is why this " +
			"route leaves nothing to redact."

	case RouteCKYCIdentifier:
		id := strings.TrimSpace(req.KYCIdentifier)
		if len(id) < 8 {
			return nil, fmt.Errorf("%w: fetching an existing record needs the holder's KYC Identifier", ErrKYCFields)
		}
		rec.FaceToFaceEquivalent = false
		rec.Tier = KYCMinimal
		rec.EvidenceKind = "Record fetched from the registry against a KYC Identifier (simulated fetch)"
		rec.EvidenceHash = hashEvidence(id)
		rec.Note = "A record fetched from the registry inherits the status of the verification that created it. " +
			"This deployment cannot read the registry, so it is treated conservatively."

	case RouteDigiLockerOVD:
		doc := strings.TrimSpace(req.DocumentRef)
		if doc == "" {
			return nil, fmt.Errorf("%w: an officially valid document route needs the document reference", ErrKYCFields)
		}
		rec.FaceToFaceEquivalent = false
		rec.Tier = KYCMinimal
		rec.EvidenceKind = "Equivalent e-document of an officially valid document (issuer signature check simulated)"
		rec.EvidenceHash = hashEvidence(doc)
		rec.Note = "An issued e-document is accepted on its issuer's signature. Nothing here checks that signature."

	case RouteVideoCIP:
		// The only route that reaches face-to-face equivalence, and the one
		// with conditions worth enforcing rather than assuming.
		missing := []string{}
		if strings.TrimSpace(req.VideoOfficial) == "" {
			missing = append(missing, "an identified official conducting the session")
		}
		if !req.LivenessPassed {
			missing = append(missing, "a liveness check")
		}
		if !req.PANShownOnCall {
			missing = append(missing, "the PAN shown on the call")
		}
		if !req.LocationInIndia {
			missing = append(missing, "the holder's live location inside India")
		}
		if len(missing) > 0 {
			k.refuse(holder, route, "VCIP_INCOMPLETE", strings.Join(missing, "; "))
			return nil, fmt.Errorf("%w: a video session is only equivalent to meeting somebody when it carries "+
				"all of its conditions; missing: %s", ErrKYCRoute, strings.Join(missing, "; "))
		}
		if strings.TrimSpace(req.OfflineRef) != "" {
			gen, err := time.Parse(time.RFC3339, strings.TrimSpace(req.OfflineGenerated))
			if err == nil && now.Sub(gen) > offlineXMLFreshness {
				return nil, fmt.Errorf("%w: the offline file relied on in the session is older than three "+
					"working days", ErrKYCStale)
			}
			rec.AadhaarLast4 = strings.TrimSpace(req.OfflineRef)[:4]
		}
		rec.FaceToFaceEquivalent = true
		rec.Tier = KYCFull
		rec.EnhancedDueDiligence = false
		rec.EvidenceKind = "Video session with an identified official (recording, face match and liveness simulated)"
		rec.EvidenceHash = hashEvidence(req.VideoOfficial + "|" + holder + "|" + now.UTC().Format(time.RFC3339))
		rec.Note = "Treated on par with meeting the holder in person, so no annual ceiling follows from being " +
			"remote. No video was recorded here, and a real session is stored in India with its activity log."

	default:
		return nil, fmt.Errorf("%w: the routes are %s, %s, %s, %s and %s", ErrKYCRoute,
			RouteAadhaarOTP, RouteAadhaarOffline, RouteCKYCIdentifier, RouteDigiLockerOVD, RouteVideoCIP)
	}

	// PAN, where one was given, is checked for shape. A malformed PAN is a
	// data entry error worth catching before it reaches a report.
	if pan := strings.ToUpper(strings.TrimSpace(req.PAN)); pan != "" {
		if !panRe.MatchString(pan) {
			return nil, fmt.Errorf("%w: a PAN is five letters, four digits and a letter", ErrKYCFields)
		}
		rec.PANLast4 = pan[len(pan)-4:]
	}

	rec.KYCID = cbdcID("KYC")
	rec.KYCIdentifier = cbdcID("CKYC")
	rec.VerifiedAt = now.UTC().Format(time.RFC3339)
	rec.ExpiresAt = now.Add(periodFor(band)).UTC().Format(time.RFC3339)
	rec.RegistryDueBy = now.Add(ckycUploadWindow).UTC().Format(time.RFC3339)
	rec.RegistryStatus = "NOT UPLOADED: this deployment has no registry connectivity. A real one has ten days."

	k.mu.Lock()
	if _, seen := k.records[holder]; !seen {
		k.order = append(k.order, holder)
	}
	k.records[holder] = rec
	k.history = append(k.history, *rec)
	k.mu.Unlock()

	// The point of the whole layer: the wallet's tier is now the output of
	// this, not an argument somebody passed.
	if k.cbdc != nil {
		k.cbdc.ApplyVerifiedKYC(holder, rec.Tier, rec.Route)
	}

	k.commit(BlockKYCVerified, map[string]interface{}{
		"kycId": rec.KYCID, "holder": holder, "route": route, "tier": rec.Tier,
		"faceToFaceEquivalent": rec.FaceToFaceEquivalent, "riskBand": band,
		"evidenceHash": rec.EvidenceHash, "aadhaarLast4": rec.AadhaarLast4,
		"expiresAt": rec.ExpiresAt, "simulated": true,
		"note": "Hash and last four digits only. No Aadhaar number, no document image and no video is held " +
			"by this rail or written to this block.",
	})
	return rec, nil
}

func periodFor(band string) time.Duration {
	switch band {
	case RiskHigh:
		return 2 * 365 * 24 * time.Hour
	case RiskLow:
		return 10 * 365 * 24 * time.Hour
	default:
		return 8 * 365 * 24 * time.Hour
	}
}

func hashEvidence(s string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(s)))
	return hex.EncodeToString(sum[:])
}

func (k *KYCDesk) refuse(holder, route, reason, detail string) {
	k.commit(BlockKYCRefused, map[string]interface{}{
		"holder": holder, "route": route, "reason": reason, "detail": detail,
	})
}

// Record returns the current verification for a holder, and says plainly when
// it has lapsed rather than treating an expired record as a valid one.
func (k *KYCDesk) Record(holder string, now time.Time) (*KYCRecord, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	rec, ok := k.records[strings.TrimSpace(holder)]
	if !ok {
		return nil, false, fmt.Errorf("%w: nobody has verified this holder", ErrKYCNotFound)
	}
	cp := *rec
	expired := false
	if exp, err := time.Parse(time.RFC3339, rec.ExpiresAt); err == nil && now.After(exp) {
		expired = true
		cp.Note = "This verification has lapsed and needs periodic updation. " + cp.Note
	}
	return &cp, expired, nil
}

func (k *KYCDesk) Records(limit int) []KYCRecord {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := []KYCRecord{}
	for i := len(k.history) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		out = append(out, k.history[i])
	}
	return out
}

func (k *KYCDesk) Status() map[string]interface{} {
	k.mu.Lock()
	byRoute := map[string]int{}
	faceToFace := 0
	for _, r := range k.records {
		byRoute[r.Route]++
		if r.FaceToFaceEquivalent {
			faceToFace++
		}
	}
	verified := len(k.records)
	k.mu.Unlock()

	return map[string]interface{}{
		"verifiedHolders":      verified,
		"faceToFaceEquivalent": faceToFace,
		"byRoute":              byRoute,
		"routes": []map[string]interface{}{
			{"route": RouteAadhaarOTP, "faceToFaceEquivalent": false, "tier": KYCMinimal,
				"annualDebitCap": rupees(otpAnnualDebitCapPaise), "enhancedDueDiligence": true,
				"meaning": "Identified without meeting anybody, so it is capped and reviewed more closely."},
			{"route": RouteAadhaarOffline, "faceToFaceEquivalent": false, "tier": KYCMinimal,
				"annualDebitCap": rupees(otpAnnualDebitCapPaise),
				"meaning":        "A signed file the holder generated, valid for three working days, carrying no Aadhaar number."},
			{"route": RouteCKYCIdentifier, "faceToFaceEquivalent": false, "tier": KYCMinimal,
				"meaning": "An existing record fetched against the holder's KYC Identifier, so they are not asked twice."},
			{"route": RouteDigiLockerOVD, "faceToFaceEquivalent": false, "tier": KYCMinimal,
				"meaning": "An issued e-document, accepted on its issuer's signature."},
			{"route": RouteVideoCIP, "faceToFaceEquivalent": true, "tier": KYCFull,
				"meaning": "A live session with an identified official, liveness, PAN on call and the holder in " +
					"India. The only route treated as equal to meeting somebody, and the only one that lifts the cap."},
		},
		"periodicUpdation": map[string]string{
			RiskHigh: "two years", RiskMedium: "eight years", RiskLow: "ten years",
		},
		"aadhaarPolicy": "This system does not accept, store or transmit Aadhaar numbers. A twelve digit number " +
			"in any field is refused outright rather than redacted, because the compliant pattern for an entity " +
			"with no licensed vault is not to receive it at all. Only the last four digits, from the reference " +
			"identifier the offline route returns, are ever held.",
		"registryUploadWindow": "ten days, with the KYC Identifier given back to the holder",
		"disclaimer":           kycDisclaimer,
	}
}

func (k *KYCDesk) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if k.chain == nil {
		return nil
	}
	txn["rail"] = "Electronic KYC (simulated verification, real flow)"
	return k.chain.Append(blockType, []map[string]interface{}{txn})
}
