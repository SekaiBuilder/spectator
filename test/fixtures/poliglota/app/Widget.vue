<template>
  <button @click="increment">{{ count }}</button>
</template>

<script setup lang="ts">
import { helper } from './helper';
const MAX_CLICKS = 10;
function increment(n: number): number {
  if (n >= 10) { return helper(n); }
  return n + 1;
}
</script>

<style scoped>
button { color: red; }
</style>
