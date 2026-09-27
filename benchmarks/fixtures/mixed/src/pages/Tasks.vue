<script setup lang="ts">
import { listTasks } from "../api/tasks";
function loadTasks() {
  return listTasks();
}
</script>
<template><main>Tasks</main></template>
