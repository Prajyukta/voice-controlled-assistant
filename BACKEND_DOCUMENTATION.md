# Agent Ru Backend Documentation

## Overview

Agent Ru is a Next.js App Router backend and browser client for a voice-first calendar and email assistant. It combines:

- GROQ AI-compatible chat completion APIs for intent detection and tool calling.
- Google OAuth 2.0 for account linking.
- Google Calendar for schedules, availability, event creation, and cancellation.
- Gmail for sending confirmed emails and automatic meeting reminders.
- Deepgram for speech-to-text and text-to-speech.
- Prisma with SQLite for tokens, staged actions, and scheduled emails.
- Vercel Cron for sending due meeting reminders.

The application intentionally stages destructive operations and requires confirmation before creating meetings, cancelling meetings, or sending assistant-composed emails.

## Project Configuration

### NPM scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run build` | Create a production build. |
| `npm run start` | Start the production server. |
| `npm run lint` | Run the configured Next.js lint command. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm run db:seed` | Upsert the demo contacts for `usr_primary`. |
| `npx prisma validate` | Validate the Prisma schema. |
| `npx prisma db push` | Synchronize the Prisma schema with SQLite. |
| `npx prisma generate` | Generate the Prisma Client. |

### Environment variables

Defined in `.env.example` and loaded locally from `.env.local`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Prisma SQLite connection, normally `file:./dev.db`. |
| `LLM_API_KEY` | API key for the OpenAI-compatible LLM provider. |
| `LLM_BASE_URL` | Provider base URL, for example OpenAI or Groq. |
| `LLM_MODEL` | Chat model name. |
| `DEEPGRAM_API_KEY` | Deepgram speech API key. |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client secret. |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL. |
| `CRON_SECRET` | Secret used to authorize the Vercel reminder endpoint. |

Never commit `.env.local` or place real credentials in `.env.example` or this document.

### Current configuration note

The LLM implementation reads `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`. If `.env.local` uses provider-specific names such as `GROQ_API_KEY`, `GROQ_BASE_URL`, and `GROQ_MODEL`, those values are not read unless they are copied to the `LLM_*` names or the code is changed to support them.

## Database Models

The Prisma schema is in `prisma/schema.prisma` and uses SQLite.

### `UserGoogleToken`

Stores the OAuth credentials associated with an application user.

- `userId`: Primary key for the application user.
- `email`: Google account email.
- `accessToken`: Current Google access token.
- `refreshToken`: Refresh token.
- `scopes`: Comma-separated granted scopes.
- `expiresAt`: Optional token expiry time.
- `createdAt`, `updatedAt`: Record timestamps.

### `StagedAction`

Stores operations that require explicit user confirmation.

- `id`: UUID action identifier.
- `userId`: Owner of the action.
- `actionType`: `create_meeting`, `cancel_meeting`, `send_email`, or `add_contact`.
- `payloadJson`: Serialized operation data.
- `isConfirmed`: Prevents a staged action from being executed twice.
- `createdAt`: Creation timestamp.

### `Contact`

Stores the local contact directory used to resolve names, aliases, and roles to email addresses.

- `userId`: Application user that owns the contact.
- `name`: Full contact name.
- `alias`: Optional spoken name or comma-separated aliases.
- `email`: Contact email, unique per user.
- `role`: Optional role or relationship.

### `ScheduledEmail`

Stores automatic meeting reminder messages.

- `id`: UUID reminder identifier.
- `userId`: Google account owner.
- `toEmail`: Recipient address.
- `subject`: Email subject.
- `body`: Email body containing the meeting link.
- `sendAt`: Due time for sending.
- `sentAt`: Null until Gmail successfully sends the message.
- `createdAt`: Creation timestamp.

The reminder query uses the `[sendAt, sentAt]` index to find due unsent messages.

## API Routes

### `GET /api/auth/google/login`

Starts Google OAuth.

Query parameter:

- `user_id`: Required application user identifier.

Behavior:

1. Creates an OAuth client.
2. Generates a Google authorization URL.
3. Includes the user ID as OAuth `state`.
4. Redirects the browser to Google.

Returns HTTP 400 when `user_id` is missing.

### `GET /api/auth/google/callback`

Completes Google OAuth.

Query parameters:


Behavior:

1. Exchanges the code for Google tokens.
2. Retrieves the Google account email.
3. Upserts `UserGoogleToken`.
4. Attempts to sync Google Contacts through the People API.
5. Returns the authenticated user ID, email, and contact sync result.

Returns HTTP 400 when `code` or `state` is missing.

### `POST /api/auth/google/contacts/sync`

Synchronizes Google Contacts into the local `Contact` directory.

JSON body:

```json
{ "user_id": "usr_primary" }
```

Requires the `contacts.readonly` OAuth scope and the People API enabled in Google Cloud.

### `POST /api/assistant/process`

Processes a text assistant request.

JSON body:

```json
{
  "user_id": "usr_primary",
  "message": "Schedule a meeting tomorrow at 3 PM",
  "timezone": "Asia/Kolkata"
}
```

The route calls `processVoiceIntent` and returns a JSON assistant result. `timezone` defaults to `Asia/Kolkata`.

Written commands use the same route and avoid speech-to-text errors.

### `POST /api/assistant/voice`

Processes recorded audio.

Multipart form fields:

- `audio`: Required audio blob, normally WebM.
- `user_id`: Required application user ID.
- `timezone`: Optional IANA timezone.

Pipeline:

1. Transcribes audio with Deepgram.
2. Sends the transcript to the LLM.
3. Synthesizes the assistant response with Deepgram.
4. Returns transcript, spoken response, base64 WAV audio, action, status, preview ID, and data.

### `POST /api/assistant/confirm`

Executes a staged action after user confirmation.

JSON body:

```json
{
  "user_id": "usr_primary",
  "preview_id": "staged-action-id"
}
```

The route executes the action through Google APIs, synthesizes the result with Deepgram, and returns spoken response audio.

Meeting confirmation also sends an immediate Gmail follow-up to attendees. The later 30- and 15-minute reminders are handled by the cron route.

### `GET /api/cron/send-reminders`

Sends due automatic meeting reminders.

Authorization header:

```text
Authorization: Bearer <CRON_SECRET>
```

Behavior:

1. Rejects requests without the correct cron secret.
2. Loads up to 100 scheduled emails where `sendAt` is due and `sentAt` is null.
3. Sends each message through Gmail.
4. Marks successful messages with `sentAt`.
5. Returns processed, sent, and failed IDs.

`vercel.json` schedules this route every five minutes:

```json
{
  "crons": [{
    "path": "/api/cron/send-reminders",
    "schedule": "*/5 * * * *"
  }]
}
```

## Assistant Functions

### `processVoiceIntent(userId, rawPrompt, userTz)`

Located in `src/lib/llm.ts`.

- Builds the current localized date/time context.
- Sends the system prompt, user message, and tool definitions to the configured OpenAI-compatible model.
- Dispatches the first returned tool call.
- Returns calendar data, availability information, a staged preview, or a direct spoken reply.
- Removes markdown-like characters from fallback spoken responses.

### `getOAuth2Client()`

Creates a Google OAuth client using the Google environment variables.

### `getAuthorizedOAuth2Client(userId)`

Loads a user token from Prisma, applies it to an OAuth client, and persists refreshed tokens when Google emits a token update.

### `listCalendarEvents(userId, timeMin, timeMax, maxResults)`

Calls Google Calendar `events.list` for the primary calendar and returns normalized event IDs, titles, times, attendees, and Meet links.

### `checkAvailability(userId, startIso, durationMinutes)`

Calls Google Calendar `freebusy.query` and returns conflict status, busy slots, start time, and end time.

### `stageMeeting(userId, payload)`

Checks availability and stores a `create_meeting` staged action containing:

- Summary.
- Start and end times.
- Attendees.
- Whether Google Meet should be created.

### `stageCancelMeeting(userId, searchTerm)`

Searches upcoming calendar events by title and stores a `cancel_meeting` staged action for the matched event.

### `stageEmail(userId, payload)`

Stores a `send_email` staged action containing recipient, subject, and body.

### `stageContact(userId, payload)`

Stores an `add_contact` staged action containing name, email, aliases, and role. The contact is written only after confirmation.

### `sendEmailDirect(userId, to, subject, bodyText)`

Builds a base64url MIME message and calls Gmail `users.messages.send`.

### `executeStagedAction(userId, previewId)`

Loads an unconfirmed action owned by the user and executes one of:

- Create a Google Calendar event and optional Google Meet conference.
- Delete a Google Calendar event.
- Send a Gmail message.
- Add or update a local contact.

After claiming an action, concurrent confirmations cannot execute it twice. For a created meeting, it sends an immediate Gmail confirmation to each attendee and, when a Meet link exists, creates two `ScheduledEmail` records scheduled for 30 and 15 minutes before the meeting.

### `transcribeAudio(audioBuffer, mimeType)`

Uses Deepgram Nova-2 prerecorded transcription with smart formatting.

### `synthesizeSpeech(text)`

Uses Deepgram Aura Asteria English text-to-speech and returns a WAV `Buffer`.

## LLM Tools

The definitions are in `src/tools/assistantTools.ts` and are sent as OpenAI function tools.

### `list_calendar_events`

Reads upcoming events in an optional time window.

Arguments:

- `time_min`: ISO-8601 start.
- `time_max`: ISO-8601 end.
- `max_results`: Maximum event count.

### `check_calendar_availability`

Checks conflicts for a proposed time slot.

Arguments:

- `start_time`: ISO-8601 time with offset.
- `duration_minutes`: Duration in minutes.

### `stage_meeting_preview`

Stages a meeting for preview and confirmation.

Arguments:

- `title`.
- `start_time`.
- `duration_minutes`.
- `attendee_emails`.
- `create_meet`.

### `stage_cancel_meeting_preview`

Stages cancellation after searching by `search_term`.

### `stage_email_preview`

Stages a client email for preview and confirmation.

Arguments:

- `recipient_email`.
- `subject`.
- `body`.

### `stage_contact_preview`

Stages a new or existing contact for preview and confirmation.

Arguments:

- `name`.
- `email`.
- `alias` (optional).
- `role` (optional).

## External APIs and SDKs

### Google OAuth 2.0

Used for account linking and refreshable credentials.

### Google Calendar API

Used for:

- Listing events.
- Checking free/busy status.
- Creating events.
- Creating Google Meet conference links.
- Deleting events.

### Gmail API

Used for sending:

- Confirmed assistant-composed emails.
- Automatic meeting reminder emails.

Required scopes include:

```text
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/contacts.readonly
```

### OpenAI-compatible Chat Completions API

Used for natural-language understanding and function/tool selection. The provider is selected by `LLM_BASE_URL`, while the code reads credentials from the `LLM_*` variables.

### Deepgram API

Used for speech recognition and speech synthesis:

- Nova-2 transcription.
- Aura Asteria English WAV synthesis.

### Prisma

Used to persist Google tokens, staged actions, and scheduled reminders in SQLite.

## Browser Component

`src/components/AudioAssistant.tsx` provides the basic client workflow:

1. Requests microphone access.
2. Records WebM audio with `MediaRecorder`.
3. Sends audio to `/api/assistant/voice`.
4. Plays returned base64 WAV audio.
5. Displays the transcript and spoken response.
6. Shows a confirmation button when a preview ID is returned.
7. Sends confirmation to `/api/assistant/confirm`.
8. Accepts written commands through `/api/assistant/process` when exact email text is needed.

`src/app/page.tsx` renders this component with the demo user ID `usr_primary`.

## Security and Operational Notes

- Keep all API keys and OAuth secrets server-side.
- Do not commit `.env.local`.
- Rotate any credential that has been exposed or shared outside the local environment.
- Validate the OAuth `state` value with a signed session in a production deployment; the current implementation uses the user ID directly.
- Protect the cron route with a strong `CRON_SECRET`.
- The current reminder sender can retry failed messages on a later cron run. A production system should add a lease or processing status to prevent duplicate sends when cron executions overlap.
- Reminder creation currently requires a confirmed meeting, attendees, and a generated Meet link.

## Validation

The project has been validated with:

```powershell
npm install
npx prisma validate
npx prisma db push
npm run typecheck
npm run build
```
