import { google } from "googleapis";
import { prisma } from "./prisma";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export async function getAuthorizedOAuth2Client(userId: string) {
  const tokenRecord = await prisma.userGoogleToken.findUnique({ where: { userId } });
  if (!tokenRecord) {
    throw new Error(`User ${userId} has not connected their Google account.`);
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tokenRecord.accessToken,
    refresh_token: tokenRecord.refreshToken,
    expiry_date: tokenRecord.expiresAt ? tokenRecord.expiresAt.getTime() : undefined,
  });

  oauth2Client.on("tokens", async (tokens) => {
    await prisma.userGoogleToken.update({
      where: { userId },
      data: {
        accessToken: tokens.access_token ?? tokenRecord.accessToken,
        refreshToken: tokens.refresh_token ?? tokenRecord.refreshToken,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
    });
  });

  return oauth2Client;
}

export async function syncGoogleContacts(userId: string) {
  const auth = await getAuthorizedOAuth2Client(userId);
  const people = google.people({ version: "v1", auth });

  const response = await people.people.connections.list({
    resourceName: "people/me",
    pageSize: 200,
    personFields: "names,emailAddresses,organizations",
  });

  const connections = [...(response.data.connections || [])];
  let nextPageToken = response.data.nextPageToken;

  while (nextPageToken) {
    const nextResponse = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: 200,
      pageToken: nextPageToken,
      personFields: "names,emailAddresses,organizations",
    });

    connections.push(...(nextResponse.data.connections || []));
    nextPageToken = nextResponse.data.nextPageToken;
  }

  let syncedCount = 0;

  for (const person of connections) {
    const primaryEmail = person.emailAddresses?.find((email) => !!email.value)?.value;
    if (!primaryEmail) continue;

    const name = person.names?.[0]?.displayName || primaryEmail.split("@")[0];
    const alias = person.names?.[0]?.givenName || name;
    const role = person.organizations?.[0]?.title || null;

    await prisma.contact.upsert({
      where: {
        userId_email: {
          userId,
          email: primaryEmail,
        },
      },
      update: {
        name,
        alias,
        role,
      },
      create: {
        userId,
        name,
        alias,
        email: primaryEmail,
        role,
      },
    });

    syncedCount += 1;
  }

  return { syncedCount };
}

// ---------------- Google Calendar Operations ----------------

export async function listCalendarEvents(userId: string, timeMin?: string, timeMax?: string, maxResults = 10) {
  const auth = await getAuthorizedOAuth2Client(userId);
  const calendar = google.calendar({ version: "v3", auth });

  const start = timeMin || new Date().toISOString();
  const end = timeMax || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: start,
    timeMax: end,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items || [];
  return events.map((event) => ({
    id: event.id,
    summary: event.summary || "Untitled Event",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    attendees: (event.attendees || []).map((a) => a.email),
    meet_link: event.hangoutLink || null,
  }));
}

export async function checkAvailability(userId: string, startIso: string, durationMinutes: number) {
  const auth = await getAuthorizedOAuth2Client(userId);
  const calendar = google.calendar({ version: "v3", auth });

  const startTime = new Date(startIso);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: [{ id: "primary" }],
    },
  });

  const busySlots = res.data.calendars?.primary?.busy || [];
  return {
    has_conflict: busySlots.length > 0,
    busy_slots: busySlots,
    start: startTime.toISOString(),
    end: endTime.toISOString(),
  };
}

export async function stageMeeting(userId: string, payload: {
  title: string;
  start_time: string;
  duration_minutes?: number;
  attendee_emails?: string[];
  create_meet?: boolean;
}) {
  const duration = payload.duration_minutes || 30;
  const availability = await checkAvailability(userId, payload.start_time, duration);

  const startTime = new Date(payload.start_time);
  const endTime = new Date(startTime.getTime() + duration * 60000);

  const staged = await prisma.stagedAction.create({
    data: {
      userId,
      actionType: "create_meeting",
      payloadJson: JSON.stringify({
        summary: payload.title,
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
        attendees: (payload.attendee_emails || []).map((email) => ({ email })),
        create_meet: payload.create_meet ?? true,
      }),
    },
  });

  return {
    preview_id: staged.id,
    action_type: "create_meeting",
    title: payload.title,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    attendees: payload.attendee_emails || [],
    has_conflict: availability.has_conflict,
  };
}

export async function stageCancelMeeting(userId: string, searchTerm: string) {
  const events = await listCalendarEvents(
    userId,
    new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    25
  );

  const matched = events.find((e) =>
    e.summary.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!matched || !matched.id) {
    throw new Error(`Could not find an upcoming meeting matching "${searchTerm}".`);
  }

  const staged = await prisma.stagedAction.create({
    data: {
      userId,
      actionType: "cancel_meeting",
      payloadJson: JSON.stringify({
        eventId: matched.id,
        summary: matched.summary,
        start: matched.start,
      }),
    },
  });

  return {
    preview_id: staged.id,
    action_type: "cancel_meeting",
    event_id: matched.id,
    title: matched.summary,
    start_time: matched.start,
  };
}

// ---------------- Gmail Operations ----------------

export async function stageEmail(userId: string, payload: {
  recipient_email: string;
  subject: string;
  body: string;
}) {
  const staged = await prisma.stagedAction.create({
    data: {
      userId,
      actionType: "send_email",
      payloadJson: JSON.stringify(payload),
    },
  });

  return {
    preview_id: staged.id,
    action_type: "send_email",
    recipient: payload.recipient_email,
    subject: payload.subject,
    body: payload.body,
  };
}

export async function stageContact(userId: string, payload: {
  name: string;
  email: string;
  alias?: string;
  role?: string;
}) {
  const staged = await prisma.stagedAction.create({
    data: {
      userId,
      actionType: "add_contact",
      payloadJson: JSON.stringify(payload),
    },
  });

  return {
    preview_id: staged.id,
    action_type: "add_contact",
    name: payload.name,
    email: payload.email,
    alias: payload.alias || null,
    role: payload.role || null,
  };
}

export async function sendEmailDirect(userId: string, to: string, subject: string, bodyText: string) {
  const auth = await getAuthorizedOAuth2Client(userId);
  const gmail = google.gmail({ version: "v1", auth });

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const messageParts = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${utf8Subject}`,
    "",
    bodyText,
  ];

  const rawMessage = Buffer.from(messageParts.join("\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: rawMessage },
  });

  return { message_id: result.data.id, status: "sent" };
}

// ---------------- Confirmation & Commit Execution ----------------

export async function executeStagedAction(userId: string, previewId: string) {
  const claimed = await prisma.stagedAction.updateMany({
    where: { id: previewId, userId, isConfirmed: false },
    data: { isConfirmed: true },
  });

  if (claimed.count !== 1) {
    throw new Error("Action not found or already executed.");
  }

  const staged = await prisma.stagedAction.findFirst({
    where: { id: previewId, userId },
  });

  if (!staged) {
    throw new Error("Action not found or already executed.");
  }

  const payload = JSON.parse(staged.payloadJson);

  let resultData: any = {};

  if (staged.actionType === "create_meeting") {
    const auth = await getAuthorizedOAuth2Client(userId);
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.events.insert({
      calendarId: "primary",
      conferenceDataVersion: payload.create_meet ? 1 : 0,
      requestBody: {
        summary: payload.summary,
        start: payload.start,
        end: payload.end,
        attendees: payload.attendees,
        ...(payload.create_meet && {
          conferenceData: {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      },
    });

    const meetingStart = new Date(payload.start.dateTime);
    const meetLink = res.data.conferenceData?.entryPoints?.[0]?.uri || null;
    const attendeeEmails = Array.isArray(payload.attendees)
      ? payload.attendees
          .map((attendee: { email?: string }) => attendee.email)
          .filter((email: string | undefined): email is string => Boolean(email))
      : [];
    const followUpSubject = `Meeting confirmed: ${payload.summary}`;
    const followUpBody = [
      `Your meeting, "${payload.summary}", is confirmed.`,
      `When: ${meetingStart.toISOString()}`,
      meetLink ? `Join here: ${meetLink}` : "",
    ].filter(Boolean).join("\n");
    const followUpResults = await Promise.allSettled(
      attendeeEmails.map((email: string) => sendEmailDirect(userId, email, followUpSubject, followUpBody))
    );
    const sentFollowUps = followUpResults.filter((result) => result.status === "fulfilled").length;
    const failedFollowUps = followUpResults.filter((result) => result.status === "rejected").length;

    resultData = {
      event_id: res.data.id,
      html_link: res.data.htmlLink,
      meet_link: meetLink,
      follow_up_emails_sent: sentFollowUps,
      follow_up_emails_failed: failedFollowUps,
      spoken: failedFollowUps > 0
        ? `Your meeting is scheduled, but I could not send ${failedFollowUps} Gmail follow-up email${failedFollowUps > 1 ? "s" : ""}.`
        : "Your meeting is scheduled and the Gmail follow-up has been sent.",
    };

    if (meetLink && Array.isArray(payload.attendees) && payload.attendees.length > 0) {
      const reminderOffsets = [30, 15];
      await prisma.scheduledEmail.createMany({
        data: reminderOffsets.flatMap((minutes) =>
          payload.attendees.map((attendee: { email: string }) => ({
            userId,
            toEmail: attendee.email,
            subject: `Reminder: ${payload.summary} starts in ${minutes} minutes`,
            body: `Reminder: ${payload.summary} starts in ${minutes} minutes. Join here: ${meetLink}`,
            sendAt: new Date(meetingStart.getTime() - minutes * 60 * 1000),
          }))
        ),
      });
    }
  } else if (staged.actionType === "cancel_meeting") {
    const auth = await getAuthorizedOAuth2Client(userId);
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({
      calendarId: "primary",
      eventId: payload.eventId,
    });

    resultData = {
      event_id: payload.eventId,
      spoken: `The meeting titled ${payload.summary} has been removed from your calendar.`,
    };
  } else if (staged.actionType === "send_email") {
    const auth = await getAuthorizedOAuth2Client(userId);
    const emailRes = await sendEmailDirect(userId, payload.recipient_email, payload.subject, payload.body);
    resultData = {
      message_id: emailRes.message_id,
      spoken: `Your email to ${payload.recipient_email} has been sent successfully.`,
    };
  } else if (staged.actionType === "add_contact") {
    const contact = await prisma.contact.upsert({
      where: { userId_email: { userId, email: payload.email } },
      update: {
        name: payload.name,
        alias: payload.alias || null,
        role: payload.role || null,
      },
      create: {
        userId,
        name: payload.name,
        email: payload.email,
        alias: payload.alias || null,
        role: payload.role || null,
      },
    });

    resultData = {
      contact_id: contact.id,
      email: contact.email,
      spoken: `${contact.name} has been added to your contacts.`,
    };
  }

  return resultData;
}