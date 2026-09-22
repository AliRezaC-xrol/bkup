/**
 * Copy text to the user's clipboard, working BOTH in secure contexts and on
 * the plain-HTTP panel most bkup installs use.
 *
 * navigator.clipboard only exists in secure contexts (HTTPS or localhost).
 * Over http://<server-ip> the Clipboard API is entirely absent, so the old
 * code threw and the "Copy shown" button silently failed with an error toast.
 * The legacy textarea + execCommand path still works there.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission may still be denied — fall through to the legacy path
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
