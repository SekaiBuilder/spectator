<?php
namespace App;
class Cart {
    const MAX_ITEMS = 20;
    public function add($item) {
        if (count($this->items) >= 20) { return false; }
        return $this->store($item);
    }
    private function store($item) { return true; }
}
