package capture

import "testing"

type meteringAction struct {
	Kind          string `json:"kind"`
	ChunkB64      string `json:"chunkB64"`
	ErrorSeen     bool   `json:"errorSeen"`
	DrainComplete bool   `json:"drainComplete"`
}

type meteringProtocolFailure struct {
	AfterContent bool    `json:"afterContent"`
	Verdict      string  `json:"verdict"`
	EventName    *string `json:"eventName"`
}

type meteringFinish struct {
	Text                   string                   `json:"text"`
	SawContent             bool                     `json:"sawContent"`
	TerminalSeen           bool                     `json:"terminalSeen"`
	IncompleteSeen         bool                     `json:"incompleteSeen"`
	RetainedBytes          int                      `json:"retainedBytes"`
	SkippedOversizedFrames int                      `json:"skippedOversizedFrames"`
	ProtocolFailure        *meteringProtocolFailure `json:"protocolFailure"`
}

type meteringCase struct {
	Name                  string           `json:"name"`
	Format                string           `json:"format"`
	AttachedMaxFrameBytes *int             `json:"attachedMaxFrameBytes"`
	Actions               []meteringAction `json:"actions"`
	FinishAfterActions    int              `json:"finishAfterActions"`
	Finish                meteringFinish   `json:"finish"`
	FinishAgain           *meteringFinish  `json:"finishAgain"`
}

func assertFinish(t *testing.T, got MeteringResult, want meteringFinish) {
	t.Helper()
	if got.Text != want.Text {
		t.Errorf("Text = %q, want %q", got.Text, want.Text)
	}
	if got.SawContent != want.SawContent {
		t.Errorf("SawContent = %v, want %v", got.SawContent, want.SawContent)
	}
	if got.TerminalSeen != want.TerminalSeen {
		t.Errorf("TerminalSeen = %v, want %v", got.TerminalSeen, want.TerminalSeen)
	}
	if got.IncompleteSeen != want.IncompleteSeen {
		t.Errorf("IncompleteSeen = %v, want %v", got.IncompleteSeen, want.IncompleteSeen)
	}
	if got.RetainedBytes != want.RetainedBytes {
		t.Errorf("RetainedBytes = %d, want %d", got.RetainedBytes, want.RetainedBytes)
	}
	if got.SkippedOversizedFrames != want.SkippedOversizedFrames {
		t.Errorf("SkippedOversizedFrames = %d, want %d", got.SkippedOversizedFrames, want.SkippedOversizedFrames)
	}
	if (got.ProtocolFailure == nil) != (want.ProtocolFailure == nil) {
		t.Errorf("ProtocolFailure = %v, want %v", got.ProtocolFailure, want.ProtocolFailure)
	} else if got.ProtocolFailure != nil {
		if got.ProtocolFailure.Verdict != want.ProtocolFailure.Verdict {
			t.Errorf("ProtocolFailure.Verdict = %q, want %q", got.ProtocolFailure.Verdict, want.ProtocolFailure.Verdict)
		}
		if got.ProtocolFailure.AfterContent != want.ProtocolFailure.AfterContent {
			t.Errorf("ProtocolFailure.AfterContent = %v, want %v", got.ProtocolFailure.AfterContent, want.ProtocolFailure.AfterContent)
		}
		gotEvent := ""
		if got.ProtocolFailure.EventName != nil {
			gotEvent = *got.ProtocolFailure.EventName
		}
		wantEvent := ""
		if want.ProtocolFailure.EventName != nil {
			wantEvent = *want.ProtocolFailure.EventName
		}
		if gotEvent != wantEvent {
			t.Errorf("ProtocolFailure.EventName = %q, want %q", gotEvent, wantEvent)
		}
	}
}

func TestMeteringObserverFixtures(t *testing.T) {
	var cases []meteringCase
	loadFixture(t, "metering.json", &cases)

	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			attached := 0
			if c.AttachedMaxFrameBytes != nil {
				attached = *c.AttachedMaxFrameBytes
			}
			observer := NewMeteringObserver(c.Format, attached)

			applyAction := func(i int, action meteringAction) {
				switch action.Kind {
				case "detach":
					observer.SwitchToDetachedMode()
				case "observe":
					chunk := mustB64(t, action.ChunkB64)
					errorSeen, drainComplete := observer.Observe(chunk)
					if errorSeen != action.ErrorSeen {
						t.Errorf("action[%d] errorSeen = %v, want %v", i, errorSeen, action.ErrorSeen)
					}
					if drainComplete != action.DrainComplete {
						t.Errorf("action[%d] drainComplete = %v, want %v", i, drainComplete, action.DrainComplete)
					}
				default:
					t.Fatalf("unknown action kind %q", action.Kind)
				}
			}

			finishAfter := c.FinishAfterActions
			if finishAfter <= 0 {
				finishAfter = len(c.Actions)
			}

			for i := 0; i < finishAfter; i++ {
				applyAction(i, c.Actions[i])
			}
			result := observer.Finish()
			assertFinish(t, result, c.Finish)

			for i := finishAfter; i < len(c.Actions); i++ {
				applyAction(i, c.Actions[i])
			}
			if c.FinishAgain != nil {
				second := observer.Finish()
				assertFinish(t, second, *c.FinishAgain)
			}
		})
	}
}
