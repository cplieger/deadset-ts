<template><p v-if="state === Level.High">{{ Level.Low }}</p>
<p :title="`level ${Level.Templated}`"></p></template>
<script lang="ts">
import { Level } from "./level.js";
const state = Level.Medium;
</script>
