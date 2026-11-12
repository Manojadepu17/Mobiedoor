import { BadgeCheck } from "lucide-react";

export function VerifiedBadge() {
  return <span className="verified-badge">
    <BadgeCheck size={14} aria-hidden="true" />
    <span>MobieDoor Verified</span>
  </span>;
}
