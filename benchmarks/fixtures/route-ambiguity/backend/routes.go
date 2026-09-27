package backend
func RegisterRoutes(router Router) {
    router.GET("/api/items", ReadItems)
    router.POST("/api/items", CreateItem)
}
func ReadItems() {}
func CreateItem() {}
