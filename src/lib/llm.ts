import OpenAI from "openai";
import { ASSISTANT_TOOLS } from "../tools/assistantTools";
import { prisma } from "./prisma";
import {
  checkAvailability,
  stageMeeting,
  listCalendarEvents,
  stageCancelMeeting,
  stageEmail,
  stageContact,
} from "./google";

// Configure client for Groq's OpenAI-compatible endpoint
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || process.env.LLM_API_KEY,
  baseURL: process.env.GROQ_BASE_URL || process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
});

const BASE_SYSTEM_PROMPT = `You are the core voice assistant engine for Agent Ru.
You manage Google Calendar meetings, detect conflicts, read upcoming schedules, and compose client emails.

ACTIVE TEAM & CONTACTS DIRECTORY:
{{CONTACTS_DIRECTORY}}

CRITICAL RULES:
1. TOOL SELECTION PRIORITY:
   - When the user asks to "schedule", "book", "set up", or "create" a meeting, ALWAYS invoke "stage_meeting_preview".
   - DO NOT call "check_calendar_availability" when the user asks to schedule. The staging tool handles conflict checks automatically.
   - ONLY call "check_calendar_availability" if the user strictly asks an informational question (e.g., "Am I free at 11 AM?", "Do I have free time tomorrow?").
  - When the user asks to add or save a contact, ALWAYS invoke "stage_contact_preview".
2. CONTACT RESOLUTION:
   - When the user refers to a person by name, alias, or role (e.g., "Manoj", "Rahul", "Tech Lead"), look up their corresponding email address from the ACTIVE TEAM & CONTACTS DIRECTORY.
   - Supply resolved email addresses in the "attendee_emails" array for meetings and in "recipient_email" for emails.
   - If a person is not listed in the directory and no email address was provided in the voice prompt, ask the user for their email address.
3. OPERATIONAL DATETIME & TIMEZONE:
   - Current Reference: {{CURRENT_DATETIME}}
   - User Timezone: {{USER_TIMEZONE}}
4. FORMATTING:
   - All date/time strings passed to tools MUST be formatted in ISO 8601 with timezone offsets.
   - NEVER make direct destructive writes. Always call the appropriate staging tool (stage_meeting_preview, stage_cancel_meeting_preview, or stage_email_preview).
5. TEXT-TO-SPEECH (TTS) GUIDELINES:
   - Zero markdown asterisks, hashes, backticks, emojis, or bullet points.
   - Keep answers concise (1 to 3 short sentences).
`;

function normalizeContactValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveContactFromPrompt(prompt: string, contacts: Array<{ name: string; alias?: string | null; email: string }>) {
  const promptNormalized = normalizeContactValue(prompt);
  const promptTokens = Array.from(new Set((prompt.match(/[a-z0-9]+/gi) || []).map((token) => normalizeContactValue(token)).filter((token) => token.length > 1)));

  const scored = contacts
    .map((contact) => {
      const variants = [
        { value: contact.name, weight: 5 },
        ...(contact.alias || "").split(",").map((alias) => ({ value: alias.trim(), weight: 4 })),
        { value: contact.email.split("@")[0], weight: 2 },
      ];

      let score = 0;
      for (const variant of variants) {
        const normalizedValue = normalizeContactValue(variant.value);
        if (!normalizedValue) continue;

        if (promptNormalized === normalizedValue || promptNormalized.includes(normalizedValue)) score += variant.weight + 2;
        if (promptTokens.includes(normalizedValue)) score += variant.weight + 3;
        if (promptTokens.some((token) => token.startsWith(normalizedValue) || normalizedValue.startsWith(token))) score += variant.weight;
      }

      return { contact, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0] && scored[0].score > 0 ? scored[0].contact : null;
}

function isEmailRequest(prompt: string) {
  return /\b(email|e-mail|mail|draft|compose|send)\b/i.test(prompt);
}

function applyDirectContactOverride(
  rawPrompt: string,
  contact: { name: string; alias?: string | null; email: string } | null,
  toolName: string,
  args: Record<string, any>
) {
  if (!contact) return args;

  const explicitEmails = Array.from(new Set((rawPrompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((value) => value.toLowerCase())));

  if (explicitEmails.length > 0 && !explicitEmails.includes(contact.email.toLowerCase())) {
    return args;
  }

  if (toolName === "stage_meeting_preview") {
    args.attendee_emails = [contact.email];
  }

  if (toolName === "stage_email_preview") {
    args.recipient_email = contact.email;
  }

  return args;
}

export async function processVoiceIntent(userId: string, rawPrompt: string, userTz = "Asia/Kolkata") {
  const contacts = await prisma.contact.findMany({
    where: { userId },
    select: { name: true, alias: true, email: true, role: true },
  });

  const contactsDirectory = contacts.length > 0
    ? contacts
        .map(
          (c: { name: string; alias: string | null; email: string; role: string | null }) =>
            `- Name: ${c.name} | Alias: ${c.alias || c.name} | Role: ${c.role || "Member"} | Email: ${c.email}`
        )
        .join("\n")
    : "No saved contacts found.";

  const currentDateTime = new Date().toLocaleString("en-US", { timeZone: userTz });
  const systemMessage = BASE_SYSTEM_PROMPT
    .replace("{{CONTACTS_DIRECTORY}}", contactsDirectory)
    .replace("{{CURRENT_DATETIME}}", currentDateTime)
    .replace("{{USER_TIMEZONE}}", userTz);

  const directContactMatch = resolveContactFromPrompt(rawPrompt, contacts);
  const enrichedPrompt = directContactMatch
    ? `${rawPrompt}\n\nKnown contact match: ${directContactMatch.name} <${directContactMatch.email}>.`
    : rawPrompt;
  const toolChoice = directContactMatch && isEmailRequest(rawPrompt)
    ? { type: "function" as const, function: { name: "stage_email_preview" } }
    : "auto" as const;

  const completion = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || process.env.LLM_MODEL || "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: enrichedPrompt },
    ],
    tools: ASSISTANT_TOOLS,
    tool_choice: toolChoice,
  });

  const message = completion.choices[0].message;

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0];
    const args = JSON.parse(toolCall.function.arguments);

    applyDirectContactOverride(rawPrompt, directContactMatch, toolCall.function.name, args);

    try {
      if (toolCall.function.name === "list_calendar_events") {
        const events = await listCalendarEvents(userId, args.time_min, args.time_max, args.max_results);
        if (events.length === 0) {
          return {
            action: "read_calendar",
            status: "completed",
            data: { events: [] },
            spoken_response: "You do not have any meetings scheduled on your calendar for that timeframe.",
          };
        }

        const summaryList = events.slice(0, 3).map((e) => e.summary).join(", ");
        return {
          action: "read_calendar",
          status: "completed",
          data: { events },
          spoken_response: `You have ${events.length} event${events.length > 1 ? "s" : ""}, including ${summaryList}.`,
        };
      }

      if (toolCall.function.name === "check_calendar_availability") {
        const result = await checkAvailability(userId, args.start_time, args.duration_minutes || 30);
        return {
          action: "check_availability",
          status: "completed",
          data: result,
          spoken_response: result.has_conflict
            ? "You have a conflicting meeting scheduled during that time."
            : "You are completely free at that time slot.",
        };
      }

      if (toolCall.function.name === "stage_meeting_preview") {
        const preview = await stageMeeting(userId, args);
        const conflictNote = preview.has_conflict
          ? " Note that you have another event scheduled around that time."
          : "";
        return {
          action: "confirmation_required",
          preview_id: preview.preview_id,
          action_type: "create_meeting",
          data: preview,
          spoken_response: `I prepared a meeting for ${preview.title}.${conflictNote} Should I confirm and send the invites?`,
        };
      }

      if (toolCall.function.name === "stage_cancel_meeting_preview") {
        const preview = await stageCancelMeeting(userId, args.search_term);
        return {
          action: "confirmation_required",
          preview_id: preview.preview_id,
          action_type: "cancel_meeting",
          data: preview,
          spoken_response: `I found the meeting titled ${preview.title}. Are you sure you want to cancel it?`,
        };
      }

      if (toolCall.function.name === "stage_email_preview") {
        const preview = await stageEmail(userId, args);
        return {
          action: "confirmation_required",
          preview_id: preview.preview_id,
          action_type: "send_email",
          data: preview,
          spoken_response: `I drafted an email to ${preview.recipient} with the subject ${preview.subject}. Shall I send it now?`,
        };
      }

      if (toolCall.function.name === "stage_contact_preview") {
        const preview = await stageContact(userId, args);
        return {
          action: "confirmation_required",
          preview_id: preview.preview_id,
          action_type: "add_contact",
          data: preview,
          spoken_response: `I prepared a new contact for ${preview.name} with email ${preview.email}. Should I save it?`,
        };
      }
    } catch (error: any) {
      const messageText = error?.message || "";
      if (/Google account|not connected|connected their Google/i.test(messageText)) {
        return {
          action: "reply",
          status: "completed",
          spoken_response: "Please connect your Google account first so I can schedule meetings and send follow-up emails.",
        };
      }
      throw error;
    }
  }

  const cleanReply = (message.content || "")
    .replace(/[*#`_~]/g, "")
    .trim();

  return {
    action: "reply",
    status: "completed",
    spoken_response: cleanReply,
  };
}