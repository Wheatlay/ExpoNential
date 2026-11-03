package app

import "time"

// stopThenForget stops the agent, waits (up to wait) until it is gone, and only then unregisters the computer:
// a still running agent would re-create the device with its next poll.
func stopThenForget(stop func(), alive func() bool, forget func() bool, wait time.Duration) bool {
	stop()
	for end := time.Now().Add(wait); alive() && time.Now().Before(end); {
		time.Sleep(100 * time.Millisecond)
	}
	return forget()
}

// stopAndForget is the real thing: the pid is read before stopAgent removes the lock.
func stopAndForget(target string) bool {
	pid := agentPID()
	return stopThenForget(func() { stopAgent(target) }, func() bool { return pid != 0 && pidAlive(pid) }, forgetOnServer, 5*time.Second)
}
