const text = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").trim();

/** One brand marker; a project named DevSpace must not repeat it as a project tag. */
export function managedSessionTitle(projectName: string, shortId: string, title: string): string {
  const project = text(projectName).replace(/[\[\]]/g, " ").trim() || "project";
  const identifier = text(shortId).replace(/[\[\]]/g, "");
  let body = text(title);
  // Strip only a leading DevSpace-generated prefix. A user's substantive title
  // and occurrences of "DevSpace" elsewhere remain unchanged.
  if (/^\[devspace\]/i.test(body)) {
    body = body.replace(/^(?:\[devspace\]\s*)+/i, "");
    const firstTag = /^\[([^\]]+)\]\s*/.exec(body);
    if (firstTag?.[1]?.toLocaleLowerCase() === project.toLocaleLowerCase()) body = body.slice(firstTag[0].length);
    const runTag = /^\[([0-9a-f]{6})\]\s*/i.exec(body);
    if (runTag) body = body.slice(runTag[0].length);
  }
  const projectTag = project.toLocaleLowerCase() === "devspace" ? "" : `[${project}]`;
  return `[DevSpace]${projectTag}[${identifier}] ${body || "Task"}`.slice(0, 160);
}
