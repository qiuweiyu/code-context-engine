package main

type cronRunner struct{}
func (cronRunner) AddFunc(string, func()) {}
var cron cronRunner
type consumerRunner struct{}
func (consumerRunner) Subscribe(string, func()) {}
var consumer consumerRunner

func main() {
  cron.AddFunc("@daily", RunCleanup)
  consumer.Subscribe("tasks.created", HandleTask)
}

func RunCleanup() { WriteAudit() }
func HandleTask() { WriteAudit() }
func WriteAudit() {
  _ = "INSERT INTO audit_events(id) VALUES (1)"
}
// consumer.Subscribe("ghost", GhostHandler)
