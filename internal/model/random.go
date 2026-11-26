package model

import "crypto/rand"

func mustRandom(buffer []byte) {
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
}
