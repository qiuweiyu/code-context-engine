<script lang="ts">
export function legacyView() { return 1; }
</script>
<script setup lang="ts">
import { fetchUsers } from "../api/users";
const props = defineProps<{ group: string }>();
function loadUsers() {
  return fetchUsers();
}
</script>
<template><main>{{ props.group }}</main></template>
