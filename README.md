# Base Power Utility Survey

A local utility reconnaissance workspace for documenting residential meter,
panel, disconnect, obstruction, and battery-install candidates. It combines a
Three.js property model, open map context, categorized photo evidence, survey
import/export, and OpenAI-assisted qualification.

## Run

```powershell
npm start
```

Open `http://127.0.0.1:4173`.

The server loads `OPENAI_API_KEY` from `.env.local` and keeps it out of the
browser. If OpenAI is unavailable, the qualification action falls back to the
same conservative local checks used by the demo workflow.

## Notes

- Survey state is stored in the current browser.
- Photo bytes are sent only when the user runs AI qualification. They are
  resized in the browser before submission.
- Exported JSON contains photo metadata, not image bytes.
- AI results are preliminary screening guidance and do not replace field,
  engineering, code, or utility approval.
