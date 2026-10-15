package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TouchSwipeTest {
    @Test
    fun aClearAxisBecomesASwipeAndTheSheetEdgeWalksHistory() {
        assertNull(swipeDirection(0f, 0f))
        assertNull(swipeDirection(40f, 0f))
        assertNull(swipeDirection(80f, 70f))
        assertEquals(SwipeDirection.RIGHT, swipeDirection(80f, 10f))
        assertEquals(SwipeDirection.LEFT, swipeDirection(-80f, 10f))
        assertEquals(SwipeDirection.DOWN, swipeDirection(10f, 80f))
        assertEquals(SwipeDirection.UP, swipeDirection(10f, -80f))
        assertEquals(-1, paperEdgeHistory(10f, 800f, SwipeDirection.RIGHT))
        assertNull(paperEdgeHistory(100f, 800f, SwipeDirection.RIGHT))
        assertEquals(1, paperEdgeHistory(780f, 800f, SwipeDirection.LEFT))
        assertNull(paperEdgeHistory(700f, 800f, SwipeDirection.LEFT))
        assertEquals(1, calendarSwipeStep(SwipeDirection.LEFT))
        assertEquals(-1, calendarSwipeStep(SwipeDirection.RIGHT))
        assertNull(calendarSwipeStep(SwipeDirection.UP))
        assertEquals("reveal", cardSwipeAction(false, SwipeDirection.LEFT))
        assertEquals("again", cardSwipeAction(true, SwipeDirection.LEFT))
        assertEquals("good", cardSwipeAction(true, SwipeDirection.RIGHT))
        assertEquals("easy", cardSwipeAction(true, SwipeDirection.UP))
        assertEquals("hard", cardSwipeAction(true, SwipeDirection.DOWN))
    }
}