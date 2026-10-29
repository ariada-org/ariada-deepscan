type Product = { id: string; name: string; price: number; image: string };

export function ProductCard({ p, onAdd }: { p: Product; onAdd: (id: string) => void }) {
  return (
    <article className="product-card">
      <img src={p.image} className="product-image" />
      <h3>{p.name}</h3>
      <p className="price">{p.price} kr</p>
      <div className="add-to-cart" onClick={() => onAdd(p.id)}>
        Add to cart
      </div>
      <a href={`/products/${p.id}`}>Read more</a>
    </article>
  );
}
