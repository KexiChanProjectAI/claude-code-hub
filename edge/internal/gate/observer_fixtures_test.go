package gate

import "testing"

type observerCaseJSON struct {
	Name     string   `json:"name"`
	Family   string   `json:"family"`
	Chunks   []string `json:"chunks"`
	Expected struct {
		SawContent            bool `json:"sawContent"`
		SawTerminal           bool `json:"sawTerminal"`
		SawIncomplete         bool `json:"sawIncomplete"`
		ObservationIncomplete bool `json:"observationIncomplete"`
		Failure               *struct {
			Verdict      string  `json:"verdict"`
			EventName    *string `json:"eventName"`
			AfterContent bool    `json:"afterContent"`
			SawMalformed bool    `json:"sawMalformed"`
		} `json:"failure"`
	} `json:"expected"`
}

func TestObserverFixtures(t *testing.T) {
	var cases []observerCaseJSON
	loadFixture(t, "observer.json", &cases)
	if len(cases) == 0 {
		t.Fatal("no fixture cases loaded")
	}

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			o := NewObserver(Family(c.Family), 0)
			for _, chunk := range c.Chunks {
				o.Observe([]byte(chunk))
			}
			got := o.Finish()

			if got.SawContent != c.Expected.SawContent {
				t.Errorf("SawContent = %v, want %v", got.SawContent, c.Expected.SawContent)
			}
			if got.SawTerminal != c.Expected.SawTerminal {
				t.Errorf("SawTerminal = %v, want %v", got.SawTerminal, c.Expected.SawTerminal)
			}
			if got.SawIncomplete != c.Expected.SawIncomplete {
				t.Errorf("SawIncomplete = %v, want %v", got.SawIncomplete, c.Expected.SawIncomplete)
			}
			if got.ObservationIncomplete != c.Expected.ObservationIncomplete {
				t.Errorf("ObservationIncomplete = %v, want %v", got.ObservationIncomplete, c.Expected.ObservationIncomplete)
			}
			if (got.Failure == nil) != (c.Expected.Failure == nil) {
				t.Fatalf("Failure presence mismatch: got %v, want %v", got.Failure, c.Expected.Failure)
			}
			if got.Failure != nil {
				wf := c.Expected.Failure
				if got.Failure.Verdict != wf.Verdict {
					t.Errorf("Failure.Verdict = %q, want %q", got.Failure.Verdict, wf.Verdict)
				}
				if !eqPtrStr(got.Failure.EventName, wf.EventName) {
					t.Errorf("Failure.EventName = %v, want %v", ptrStr(got.Failure.EventName), ptrStr(wf.EventName))
				}
				if got.Failure.AfterContent != wf.AfterContent {
					t.Errorf("Failure.AfterContent = %v, want %v", got.Failure.AfterContent, wf.AfterContent)
				}
				if got.Failure.SawMalformed != wf.SawMalformed {
					t.Errorf("Failure.SawMalformed = %v, want %v", got.Failure.SawMalformed, wf.SawMalformed)
				}
			}
		})
	}
}

func eqPtrStr(a, b *string) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	return a == nil || *a == *b
}
