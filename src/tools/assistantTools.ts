import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const ASSISTANT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_calendar_events",
      description: "Retrieve upcoming meetings and calendar events within a specified timeframe.",
      parameters: {
        type: "object",
        properties: {
          time_min: {
            type: "string",
            description: "ISO 8601 string for start of time window. Defaults to start of today.",
          },
          time_max: {
            type: "string",
            description: "ISO 8601 string for end of time window. Defaults to end of today.",
          },
          max_results: {
            type: "integer",
            default: 10,
            description: "Max number of events to fetch.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_calendar_availability",
      description: "Check whether the user is free or has scheduling conflicts during a proposed time window.",
      parameters: {
        type: "object",
        properties: {
          start_time: {
            type: "string",
            description: "ISO 8601 formatted datetime with offset, e.g. 2026-09-26T11:00:00+05:30",
          },
          duration_minutes: {
            type: "integer",
            default: 30,
            description: "Duration of the proposed slot in minutes.",
          },
        },
        required: ["start_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stage_meeting_preview",
      description: "Stages a meeting event for user preview and verbal confirmation before booking on Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title or topic of the meeting." },
          start_time: { type: "string", description: "ISO 8601 formatted datetime with offset." },
          duration_minutes: { type: "integer", default: 30, description: "Meeting length in minutes." },
          attendee_emails: {
            type: "array",
            items: { type: "string" },
            description: "Attendee email addresses.",
          },
          create_meet: { type: "boolean", default: true, description: "Generate a Google Meet link." },
        },
        required: ["title", "start_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stage_cancel_meeting_preview",
      description: "Stages a meeting cancellation for user verification before deleting it from Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          search_term: {
            type: "string",
            description: "Title keyword, person name, or date/time identifier for the meeting to cancel.",
          },
        },
        required: ["search_term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stage_email_preview",
      description: "Stages an email to a client for user preview and voice confirmation before sending via Gmail.",
      parameters: {
        type: "object",
        properties: {
          recipient_email: { type: "string", description: "Client destination email address." },
          subject: { type: "string", description: "Subject of the email." },
          body: { type: "string", description: "Body of the email." },
        },
        required: ["recipient_email", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stage_contact_preview",
      description: "Stages a new contact for user confirmation before saving it to the contacts directory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact's full name." },
          email: { type: "string", description: "Contact's email address." },
          alias: { type: "string", description: "Optional spoken name or comma-separated aliases." },
          role: { type: "string", description: "Optional role or relationship." },
        },
        required: ["name", "email"],
      },
    },
  },
];