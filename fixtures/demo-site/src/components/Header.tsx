import { useState } from "react";
import { Link } from "./Link";

export function Header({ cartCount }: { cartCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <Link to="/">Nordic Outdoor Gear</Link>
      <button className="menu-toggle" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </button>
      <a href="/cart" className="cart">Cart ({cartCount})</a>
      {open && (
        <nav aria-label="Main">
          <a href="/products">Products</a>
          <a href="/stores">Stores</a>
        </nav>
      )}
    </header>
  );
}
