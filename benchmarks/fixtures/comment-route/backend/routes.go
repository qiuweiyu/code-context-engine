package backend

func RegisterRoutes(router Router) {
    router.GET("/api/tasks", ListTasks)
}
func ListTasks() {
    // SELECT * FROM phantom_tasks
}
