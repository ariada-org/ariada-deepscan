import { useState } from "react";

export function Checkout() {
  const [card, setCard] = useState("");
  return (
    <main>
      <h1>Checkout</h1>
      <h2>Payment</h2>
      <input value={card} onChange={(e) => setCard(e.target.value)} placeholder="Card number" />
      <span className="error" style={{ color: "#ff7777", backgroundColor: "#ffffff" }}>Invalid card</span>
      <div tabIndex={3} role="button" onClick={() => alert("paid")}>Pay now</div>
    </main>
  );
}
