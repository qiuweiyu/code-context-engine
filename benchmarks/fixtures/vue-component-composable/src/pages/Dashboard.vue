<script setup lang="ts">
import UserCard from "../components/UserCard.vue";
import { useUsers } from "../composables/useUsers";
defineOptions({ name: "DashboardPage" });
function loadUsers() { return useUsers(); }
</script>
<template><UserCard /></template>
