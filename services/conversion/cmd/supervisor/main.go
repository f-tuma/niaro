// This intentionally unavailable skeleton is not registered or packaged.
// Durable startup/ledger, qualification and the confinement gate belong to B.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "conversion supervisor unavailable: checkpoint B required")
	os.Exit(1)
}
