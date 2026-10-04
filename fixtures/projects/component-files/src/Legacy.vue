<template><p>{{ value }}</p></template>
<script>
import { usedByJavaScript } from "./helpers.js";
export default { data() { return { value: usedByJavaScript() }; } };
</script>
