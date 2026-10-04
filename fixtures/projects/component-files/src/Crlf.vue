<template>
  <p>{{ row.label }}</p>
</template>
<script lang="ts">
interface Row {
  label: string;
  unread: number;
  note: string;
}
const row: Row = { label: "a", unread: 0, note: "" };
</script>
