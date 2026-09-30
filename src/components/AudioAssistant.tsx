"use client";

import { useState, useRef } from "react";

export default function AudioAssistant({ userId }: { userId: string }) {
  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [replyText, setReplyText] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [contactsStatus, setContactsStatus] = useState("");
  const [writtenCommand, setWrittenCommand] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const confirmingRef = useRef(false);

  const playBase64Audio = (base64Data: string) => {
    if (!base64Data) return;
    activeAudioRef.current?.pause();
    const audio = new Audio(`data:audio/wav;base64,${base64Data}`);
    activeAudioRef.current = audio;
    void audio.play();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = handleAudioSubmit;
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      alert("Microphone permission required.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleAudioSubmit = async () => {
    setLoading(true);
    const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", audioBlob, "user_speech.webm");
    formData.append("user_id", userId);
    formData.append("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);

    try {
      const res = await fetch("/api/assistant/voice", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      setTranscript(data.user_transcript || "");
      setReplyText(data.spoken_response || "");
      setPreviewId(data.preview_id || null);

      if (data.audio_base64) {
        playBase64Audio(data.audio_base64);
      }
    } catch (err) {
      console.error("Audio pipeline error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleWrittenSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = writtenCommand.trim();
    if (!message || loading) return;

    setLoading(true);
    setTranscript(message);

    try {
      const res = await fetch("/api/assistant/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          message,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = await res.json();

      setReplyText(res.ok ? data.spoken_response || "" : data.error || "Request failed.");
      setPreviewId(res.ok ? data.preview_id || null : null);
      setWrittenCommand("");
    } catch {
      setReplyText("The written request could not be processed.");
      setPreviewId(null);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!previewId || confirmingRef.current) return;
    confirmingRef.current = true;
    setLoading(true);

    try {
      const res = await fetch("/api/assistant/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, preview_id: previewId }),
      });
      const data = await res.json();

      setReplyText(data.spoken_response);
      setPreviewId(null);

      if (data.audio_base64) {
        playBase64Audio(data.audio_base64);
      }
    } catch (err) {
      console.error("Confirmation error:", err);
    } finally {
      confirmingRef.current = false;
      setLoading(false);
    }
  };

  const syncContacts = async () => {
    setContactsStatus("Syncing contacts...");

    try {
      const res = await fetch("/api/auth/google/contacts/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();

      setContactsStatus(res.ok
        ? `${data.synced_contacts} Google contacts synced.`
        : data.detail || data.error || "Contacts sync failed.");
    } catch {
      setContactsStatus("Contacts sync failed. Reconnect Google and grant Contacts access.");
    }
  };

  return (
    <div style={{ maxWidth: 440, margin: "40px auto", padding: 24, border: "1px solid #e2e8f0", borderRadius: 16, fontFamily: "sans-serif" }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Voice Assistant Console</h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
        User: <code>{userId}</code>
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
        <a
          href={`/api/auth/google/login?user_id=${encodeURIComponent(userId)}`}
          style={{ background: "#fff", color: "#1e3a8a", border: "1px solid #93c5fd", padding: "8px 10px", borderRadius: 6, fontSize: 12, textDecoration: "none" }}
        >
          Connect Google Contacts
        </a>
        <button
          onClick={syncContacts}
          disabled={loading}
          style={{ background: "#dbeafe", color: "#1e3a8a", border: "1px solid #93c5fd", padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
        >
          Sync Contacts
        </button>
      </div>

      {contactsStatus && <p style={{ color: "#475569", fontSize: 12, margin: "-8px 0 16px" }}>{contactsStatus}</p>}

      <form onSubmit={handleWrittenSubmit} style={{ marginBottom: 20 }}>
        <label htmlFor="written-command" style={{ display: "block", color: "#334155", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          Written command
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="written-command"
            value={writtenCommand}
            onChange={(event) => setWrittenCommand(event.target.value)}
            placeholder="Email Manoj at iammanojkumarrath@gmail.com..."
            disabled={loading}
            style={{ flex: 1, minWidth: 0, border: "1px solid #cbd5e1", borderRadius: 6, padding: "9px 10px", fontSize: 12 }}
          />
          <button
            type="submit"
            disabled={loading || !writtenCommand.trim()}
            style={{ background: "#0f766e", color: "#fff", border: "none", padding: "8px 12px", borderRadius: 6, cursor: loading ? "wait" : "pointer", fontSize: 12, opacity: loading || !writtenCommand.trim() ? 0.6 : 1 }}
          >
            Send
          </button>
        </div>
      </form>

      <div style={{ textAlign: "center", margin: "24px 0" }}>
        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={loading}
          style={{
            width: 80,
            height: 80,
            borderRadius: "50%",
            backgroundColor: isRecording ? "#ef4444" : "#2563eb",
            color: "#fff",
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {isRecording ? "Stop" : "Speak"}
        </button>
      </div>

      {loading && <p style={{ textAlign: "center", color: "#64748b", fontSize: 14 }}>Processing audio...</p>}

      {transcript && (
        <div style={{ padding: 12, background: "#f8fafc", borderRadius: 8, margin: "12px 0", fontSize: 14 }}>
          <strong>Heard:</strong> &quot;{transcript}&quot;
        </div>
      )}

      {replyText && (
        <div style={{ padding: 12, background: "#eff6ff", color: "#1e3a8a", borderRadius: 8, margin: "12px 0", fontSize: 14 }}>
          <strong>Assistant:</strong> {replyText}

          {previewId && (
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                onClick={handleConfirm}
                disabled={loading}
                style={{ background: "#16a34a", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: loading ? "wait" : "pointer", fontSize: 12, opacity: loading ? 0.7 : 1 }}
              >
                Yes, Confirm Action
              </button>
              <button
                onClick={() => setPreviewId(null)}
                style={{ background: "#cbd5e1", color: "#334155", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}