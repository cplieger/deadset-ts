<script context="module" lang="ts">
  export const shared = 1;
</script>

<script lang="ts">
  import { readInMarkup } from "./helpers.js";
  const doubled = shared * 2;
</script>

<p>{readInMarkup()} {doubled}</p>
