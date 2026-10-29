<template>
  <div class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
    <h2 :id="titleId">{{ title }}</h2>
    <button class="close" @click="$emit('close')"><i class="icon-x"></i></button>
    <slot />
    <a href="#" @click.prevent="more">Read more</a>
    <img :src="banner" :alt="bannerAlt" />
  </div>
</template>

<script setup>
defineProps({ title: String, titleId: String, banner: String, bannerAlt: String });
</script>

<style scoped>
.close:focus { outline: none; }
.modal { color: #767676; background-color: #ffffff; }
</style>
