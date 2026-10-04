<template><p v-if="state === Level.High">{{ Level.Low }}</p></template>
<script lang="ts">
import { Level } from "./level.js";
const state = Level.Medium;
</script>
