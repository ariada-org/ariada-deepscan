import type { ReactNode } from "react";
export function Link({ to, children }: { to: string; children: ReactNode }) {
  return <a href={to}>{children}</a>;
}
