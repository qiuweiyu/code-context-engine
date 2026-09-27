<script setup lang="ts">
import { fetchUsers } from "../api";
function loadUsers() {
  return fetchUsers();
}
</script>
<template><main>Users</main></template>
