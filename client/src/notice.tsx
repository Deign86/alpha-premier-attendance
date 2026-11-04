import { Check } from "lucide-react";

/** What a message means, set where the message is made: good news, work in progress or a note, or a problem. */
export type NoticeTone = "success" | "info" | "error";
export type Notice = { tone: NoticeTone; text: string };

/** One message line coloured by its tone: gold with a check for success, muted grey for info, coral for errors. */
export function NoticeLine({ notice, className = "" }: { notice: Notice | null; className?: string }) {
  if (!notice) return null;
  return (
    <p className={`notice is-${notice.tone} ${className}`.trim()} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.tone === "success" && <Check size={14} aria-hidden="true" />}
      <span>{notice.text}</span>
    </p>
  );
}
