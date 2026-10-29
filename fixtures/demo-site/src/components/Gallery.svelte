<script>
  export let images = [];
</script>

<div class="gallery">
  {#each images as { src, alt }}
    <img {src} {alt} />
  {/each}
  <iframe src="https://www.youtube-nocookie.com/embed/xyz" width="560" height="315"></iframe>
  <video src="/promo.mp4" autoplay loop></video>
</div>
