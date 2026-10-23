package app
import app.data.Repo
const val MAX_ITEMS = 30
class Cart(private val repo: Repo) {
    fun add(item: Int, count: Int): Boolean {
        if (count >= 10 && item > 0) { return false }
        for (i in 0..count) { helper(i) }
        try { repo.save(item) } catch (e: Exception) { }
        when (item) { 1 -> helper(1); else -> helper(2) }
        return true
    }
    private fun helper(i: Int) { }
}
fun main() { Cart(Repo()).add(1, 2) }
