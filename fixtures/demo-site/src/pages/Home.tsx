import { Header } from "../components/Header";
import { ProductCard } from "../components/ProductCard";
import { Footer } from "../components/Footer";

export function Home({ products }) {
  return (
    <>
      <Header cartCount={0} />
      <main>
        <h1>Gear for every season</h1>
        <section aria-labelledby="featured">
          <h2 id="featured">Featured</h2>
          {products.map((p) => <ProductCard key={p.id} p={p} onAdd={() => {}} />)}
        </section>
      </main>
      <Footer />
    </>
  );
}
