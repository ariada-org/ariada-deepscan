export default function SearchForm({ onSearch }) {
  return (
    <form role="search" onSubmit={onSearch}>
      <input type="search" name="q" placeholder="Search products" />
      <label htmlFor="newsletter-email">E-mail</label>
      <input id="newsletter-email" type="email" name="email" />
      <button type="submit">Search</button>
    </form>
  );
}
