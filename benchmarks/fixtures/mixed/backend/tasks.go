package backend

func RegisterRoutes(router Router) {
    router.GET("/api/tasks", ListTasks)
}

func ListTasks() {
    ReadTasks()
}

func ReadTasks() {
    query := "SELECT * FROM tasks"
    _ = query
}
